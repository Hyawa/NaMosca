<?php

declare(strict_types=1);

namespace NaMosca\Http\Controllers;

use NaMosca\Core\Env;
use NaMosca\Core\Response;

final class HealthController
{
    public function health(): void
    {
        $payload = [
            'ok' => true,
            'app' => 'Na Mosca!',
            'env' => Env::get('APP_ENV', 'local'),
        ];
        Response::json($payload);
    }
}
