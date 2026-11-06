<?php

declare(strict_types=1);

namespace NaMosca\Support;

use Normalizer;

final class Str
{
    /**
     * Normalização de respostas: minúsculas, sem acento, sem pontuação,
     * sem espaços. "Pão de Queijo" → "paodequeijo".
     */
    public static function normalizeAnswer(string $raw): string
    {
        $s = mb_strtolower(trim($raw), 'UTF-8');
        if ($s === '') {
            return '';
        }
        $decomposed = Normalizer::normalize($s, Normalizer::FORM_D);
        if ($decomposed !== false) {
            $s = $decomposed;
        }
        // Remove marcas diacríticas (º, ~, ^, ´, `) que ficarem após NFD.
        $s = preg_replace('~\p{Mn}+~u', '', $s) ?? $s;
        // Mantém apenas letras e números.
        $s = preg_replace('~[^\p{L}\p{Nd}]+~u', '', $s) ?? $s;
        return $s;
    }

    public static function normalizeName(string $raw): string
    {
        $s = mb_strtolower(trim($raw), 'UTF-8');
        $decomposed = Normalizer::normalize($s, Normalizer::FORM_D);
        if ($decomposed !== false) {
            $s = $decomposed;
        }
        $s = preg_replace('~\p{Mn}+~u', '', $s) ?? $s;
        $s = preg_replace('~[^\p{L}\p{Nd} ]+~u', '', $s) ?? $s;
        return trim(preg_replace('~\s+~u', ' ', $s) ?? $s);
    }

    public static function shortName(string $raw, int $max = 24): string
    {
        $s = trim($raw);
        $s = preg_replace('~\s+~u', ' ', $s) ?? $s;
        if (mb_strlen($s) > $max) {
            $s = mb_substr($s, 0, $max);
        }
        return $s;
    }
}
