<?php

declare(strict_types=1);

namespace NaMosca\Core;

final class Router
{
    /** @var array<int,array{method:string,pattern:string,handler:callable}> */
    private array $routes = [];

    public function get(string $pattern, callable $handler): void
    {
        $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->add('POST', $pattern, $handler);
    }

    public function add(string $method, string $pattern, callable $handler): void
    {
        $pattern = '/' . ltrim($pattern, '/');
        $this->routes[] = ['method' => strtoupper($method), 'pattern' => $pattern, 'handler' => $handler];
    }

    public function dispatch(Request $request): void
    {
        $found = false;
        $pathAllowed = false;

        foreach ($this->routes as $route) {
            if ($route['method'] !== $request->method()) {
                continue;
            }
            $regex = '~^' . preg_replace('~\{([a-zA-Z_][a-zA-Z0-9_]*)\}~', '(?P<$1>[^/]+)', $route['pattern']) . '$~';
            if (preg_match($regex, $request->path(), $m) !== 1) {
                continue;
            }
            $found = true;
            $params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY);
            $params = array_map('rawurldecode', $params);
            try {
                ($route['handler'])(...array_values($params), ...[]);
            } catch (\TypeError $e) {
                Response::json(['error' => 'Bad Request'], 400);
            }
            return;
        }

        if ($found) {
            Response::json(['error' => 'Method Not Allowed'], 405);
            return;
        }
        Response::json(['error' => 'Not Found'], 404);
    }
}
