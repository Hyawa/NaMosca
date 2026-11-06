<?php

declare(strict_types=1);

namespace NaMosca\Core;

final class Response
{
    public static function json(mixed $data, int $status = 200, array $headers = []): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        foreach ($headers as $key => $value) {
            if (is_string($value)) {
                header("{$key}: {$value}");
            }
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public static function error(string $message, int $status = 400, array $extra = []): void
    {
        self::json(['error' => $message] + $extra, $status);
    }

    /** 304 só funciona com ETag previamente enviado. */
    public static function notModified(array $headers = []): void
    {
        foreach ($headers as $key => $value) {
            if (is_string($value)) {
                header("{$key}: {$value}");
            }
        }
        http_response_code(304);
    }
}
