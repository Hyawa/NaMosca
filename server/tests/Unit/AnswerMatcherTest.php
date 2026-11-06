<?php

declare(strict_types=1);

namespace NaMosca\Tests\Unit;

use NaMosca\Domain\AnswerMatcher;
use PHPUnit\Framework\TestCase;

final class AnswerMatcherTest extends TestCase
{
    private function card(string $answer, array $aliases = []): array
    {
        return [
            'answer' => $answer,
            'answer_norm' => \NaMosca\Support\Str::normalizeAnswer($answer),
            'aliases' => json_encode($aliases, JSON_UNESCAPED_UNICODE),
        ];
    }

    public function testRespostaIgualCasa(): void
    {
        self::assertTrue(AnswerMatcher::match($this->card('Pizza'), 'pizza'));
        self::assertTrue(AnswerMatcher::match($this->card('Pão de Queijo'), 'Pão de queijo'));
    }

    public function testAliasCasa(): void
    {
        self::assertTrue(AnswerMatcher::match($this->card('Cachorro', ['cao', 'dog']), 'CAO'));
        self::assertTrue(AnswerMatcher::match($this->card('Cachorro', ['cao', 'dog']), 'Dog'));
    }

    public function testAcentoEPontuacaoSaoTolerados(): void
    {
        self::assertTrue(AnswerMatcher::match($this->card('Açaí'), 'acai'));
        self::assertTrue(AnswerMatcher::match($this->card('Guarda-Chuva'), 'guarda chuva'));
    }

    public function testErroDeDigitacaoToleradoSoEmPalavrasLongas(): void
    {
        // 8+ letras: tolera 1 typo
        self::assertTrue(AnswerMatcher::match($this->card('Liquidificador'), 'liquidificadr'));
        // Palavras curtas: sem tolerância
        self::assertFalse(AnswerMatcher::match($this->card('Peixe'), 'peixeX'));
    }

    public function testRespostaErradaFalsaNãoCasa(): void
    {
        self::assertFalse(AnswerMatcher::match($this->card('Pizza'), 'lasanha'));
        self::assertFalse(AnswerMatcher::match($this->card('Pizza'), 'pizzaria'));
        self::assertFalse(AnswerMatcher::match($this->card('Sol'), 'lua'));
    }

    public function testPontosPorPista(): void
    {
        self::assertSame(10, AnswerMatcher::pointsForClue(0));
        self::assertSame(7, AnswerMatcher::pointsForClue(1));
        self::assertSame(4, AnswerMatcher::pointsForClue(2));
    }
}
