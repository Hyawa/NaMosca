<?php

declare(strict_types=1);

namespace NaMosca\Tests\Unit;

use NaMosca\Support\Str;
use PHPUnit\Framework\TestCase;

final class StrTest extends TestCase
{
    public function testNormalizaMinusculasEAcentos(): void
    {
        self::assertSame('paodequeijo', Str::normalizeAnswer('Pão de Queijo'));
        self::assertSame('acai', Str::normalizeAnswer('Açaí'));
        self::assertSame('coracao', Str::normalizeAnswer('CORACÃO'));
    }

    public function testRemovePontuacaoEEspacos(): void
    {
        self::assertSame('guardachuva', Str::normalizeAnswer('Guarda-Chuva!'));
        self::assertSame('van gogh', Str::normalizeName('   Van   GOGH  '));
    }

    public function testVazioFicaVazio(): void
    {
        self::assertSame('', Str::normalizeAnswer('   '));
    }

    public function testNomesMantemUmEspacoEntrePalavras(): void
    {
        self::assertSame('ana clara', Str::normalizeName('ana    clara'));
    }

    public function testShortNameCortaNoLimite(): void
    {
        $long = str_repeat('a', 40);
        self::assertSame(24, mb_strlen(Str::shortName($long)));
    }
}
