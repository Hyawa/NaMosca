<?php

declare(strict_types=1);

namespace NaMosca\Core;

final class Request
{
    private string $method;
    private string $path;
    /** @var array<string,mixed> */
    private array $body;

    public function __construct(string $method, string $path, array $body = [])
    {
        $this->method = strtoupper($method);
        $this->path = '/' . ltrim($path, '/');
        $this->body = $body;
    }

    public static function fromGlobals(): self
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = parse_url($uri, PHP_URL_PATH);
        // Remove prefixo /api se index.php está montado com ele.
        if (is_string($path) && str_starts_with($path, '/api')) {
            $path = substr($path, 4) ?: '/';
        }
        $body = [];
        if (self::wantsBody($method)) {
            $raw = file_get_contents('php://input') ?: '';
            if ($raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $body = $decoded;
                }
            }
        }
        return new self($method, is_string($path) ? $path : '/', $body);
    }

    private static function wantsBody(string $method): bool
    {
        return in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
    }

    public function method(): string
    {
        return $this->method;
    }

    public function path(): string
    {
        return $this->path;
    }

    public function bearerToken(): ?string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (is_string($header) && preg_match('/^Bearer\s+(\S+)$/i', trim($header), $m) === 1) {
            return $m[1];
        }
        return null;
    }

    public function input(string $key, ?string $default = null): ?string
    {
        $value = $this->body[$key] ?? null;
        return is_scalar($value) ? (string) $value : $default;
    }

    public function all(): array
    {
        return $this->body;
    }

    public function ip(): string
    {
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }
}
