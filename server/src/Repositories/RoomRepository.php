<?php

declare(strict_types=1);

namespace NaMosca\Repositories;

use NaMosca\Core\Db;

final class RoomRepository
{
    private const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 1, 0

    public function findByCode(string $code): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM rooms WHERE code = ?');
        $stmt->execute([mb_strtoupper(trim($code))]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /** SELECT ... FOR UPDATE — precisa estar dentro de uma transação. */
    public function lockById(int $roomId): array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM rooms WHERE id = ? FOR UPDATE');
        $stmt->execute([$roomId]);
        $row = $stmt->fetch();
        if ($row === false) {
            throw new \RuntimeException('Sala não encontrada');
        }
        return $row;
    }

    public function getById(int $roomId): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM rooms WHERE id = ?');
        $stmt->execute([$roomId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function generateCode(): string
    {
        $alphabet = self::CODE_ALPHABET;
        $len = 4;
        $stmt = Db::pdo()->prepare('SELECT id FROM rooms WHERE code = ?');
        for ($try = 0; $try < 20; $try++) {
            $code = '';
            for ($i = 0; $i < $len; $i++) {
                $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $stmt->execute([$code]);
            if ($stmt->fetch() === false) {
                return $code;
            }
        }
        throw new \RuntimeException('Não foi possível gerar código de sala.');
    }

    public function create(array $data): array
    {
        $stmt = Db::pdo()->prepare(
            'INSERT INTO rooms (code, mode, total_rounds, seed, settings)
             VALUES (:code, :mode, :total_rounds, :seed, :settings)'
        );
        $stmt->execute([
            ':code' => $data['code'],
            ':mode' => $data['mode'],
            ':total_rounds' => $data['total_rounds'],
            ':seed' => random_int(1, 2147483647),
            ':settings' => json_encode($data['settings'], JSON_UNESCAPED_UNICODE),
        ]);
        return $this->getById((int) Db::pdo()->lastInsertId()) ?? throw new \RuntimeException('Falha ao criar sala');
    }

    /** Atualiza campos e incrementa a versão da sala. */
    public function updateFields(int $roomId, array $fields): void
    {
        if ($fields === []) {
            return;
        }
        $sets = [];
        foreach (array_keys($fields) as $key) {
            preg_match('/^[a-z][a-z0-9_]*$/i', $key) === 1 || throw new \InvalidArgumentException("Campo inválido: {$key}");
            $sets[] = "`{$key}` = :set_{$key}";
        }
        $sets[] = '`version` = `version` + 1';
        $sql = 'UPDATE rooms SET ' . implode(', ', $sets) . ' WHERE `id` = :id';

        $stmt = Db::pdo()->prepare($sql);
        foreach ($fields as $key => $value) {
            $stmt->bindValue(":set_{$key}", $value);
        }
        $stmt->bindValue(':id', $roomId);
        $stmt->execute();
    }

    /** Invalida o ETag do polling sem alterar nenhum outro campo. */
    public function bumpVersion(int $roomId): void
    {
        Db::pdo()->prepare('UPDATE rooms SET version = version + 1 WHERE id = ?')
            ->execute([$roomId]);
    }

    public function isPhaseExpired(int $roomId): bool
    {
        $stmt = Db::pdo()->prepare('SELECT phase_ends_at < NOW(3) FROM rooms WHERE id = ?');
        $stmt->execute([$roomId]);
        return (bool) $stmt->fetchColumn();
    }

    /** Milissegundos restantes do timer atual (0 se expirado). */
    public function phaseEndsInMs(int $roomId): ?int
    {
        $stmt = Db::pdo()->prepare(
            'SELECT
                CASE
                    WHEN phase_ends_at IS NULL THEN NULL
                    ELSE GREATEST(0, TIMESTAMPDIFF(MICROSECOND, NOW(3), phase_ends_at) DIV 1000)
                END
             FROM rooms WHERE id = ?'
        );
        $stmt->execute([$roomId]);
        $value = $stmt->fetchColumn();
        return $value === null ? null : (int) $value;
    }

    public function resetForRematch(int $roomId): void
    {
        // Devolve a contagem de uso das cartas antes de remover o histórico.
        Db::pdo()->prepare(
            'UPDATE cards c
             JOIN room_rounds r ON r.card_id = c.id
             SET c.times_used = GREATEST(0, c.times_used - 1)
             WHERE r.room_id = ?'
        )->execute([$roomId]);

        Db::pdo()->prepare('DELETE FROM answers WHERE room_id = ?')->execute([$roomId]);
        Db::pdo()->prepare('DELETE FROM room_rounds WHERE room_id = ?')->execute([$roomId]);

        Db::pdo()->prepare(
            "UPDATE rooms
             SET status = 'lobby', round_number = 0, clue_index = 0, phase = 'idle',
                 phase_ends_at = NULL, sudden_death = 0, card_skips = 0, version = version + 1
             WHERE id = ?"
        )->execute([$roomId]);
    }
}
