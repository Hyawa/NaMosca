<?php

declare(strict_types=1);

namespace NaMosca\Support;

final class Token
{
    /** Token transparente entregue ao cliente (guardado no localStorage). */
    public static function generate(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
    }

    /** Hash SHA-256 para persistir no banco. */
    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }
}
