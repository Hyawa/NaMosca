<?php

declare(strict_types=1);

namespace NaMosca\Domain;

use NaMosca\Support\Str;

final class AnswerMatcher
{
    public const POINTS = [10, 7, 4];

    /** Erro de digitação tolerado no match por distância. */
    private const MAX_TOLERANCE = 1;
    private const MIN_LEN_FOR_TOLERANCE = 7;

    /**
     * Verifica se o palpite casou com a resposta ou um dos aliases.
     * $cardRow é uma linha da tabela cards.
     */
    public static function match(array $cardRow, string $guess): bool
    {
        $guessNorm = Str::normalizeAnswer($guess);
        if ($guessNorm === '') {
            return false;
        }

        $candidates = [$cardRow['answer_norm']];
        $aliases = json_decode((string) $cardRow['aliases'], true);
        if (is_array($aliases)) {
            foreach ($aliases as $alias) {
                if (is_string($alias)) {
                    $normAlias = Str::normalizeAnswer($alias);
                    if ($normAlias !== '') {
                        $candidates[] = $normAlias;
                    }
                }
            }
        }
        $candidates = array_values(array_unique($candidates));

        foreach ($candidates as $candidate) {
            if ($guessNorm === $candidate) {
                return true;
            }
            if (mb_strlen($candidate) >= self::MIN_LEN_FOR_TOLERANCE
                && levenshtein($guessNorm, $candidate) <= self::MAX_TOLERANCE) {
                return true;
            }
        }
        return false;
    }

    public static function pointsForClue(int $clueIndex): int
    {
        return self::POINTS[$clueIndex] ?? 4;
    }
}
