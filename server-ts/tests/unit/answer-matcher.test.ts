// Port de server/tests/Unit/AnswerMatcherTest.php
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches, pointsForClue } from '../../src/domain/answer-matcher.js';
import { normalizeAnswer } from '../../src/support/str.js';

function card(answer: string, aliases: string[] = []) {
  return {
    answer,
    answer_norm: normalizeAnswer(answer),
    aliases,
  };
}

describe('match', () => {
  it('resposta igual casa', () => {
    assert.equal(matches(card('Pizza'), 'pizza'), true);
    assert.equal(matches(card('Pão de Queijo'), 'Pão de queijo'), true);
  });

  it('alias casa', () => {
    assert.equal(matches(card('Cachorro', ['cao', 'dog']), 'CAO'), true);
    assert.equal(matches(card('Cachorro', ['cao', 'dog']), 'Dog'), true);
  });

  it('acento e pontuação são tolerados', () => {
    assert.equal(matches(card('Açaí'), 'acai'), true);
    assert.equal(matches(card('Guarda-Chuva'), 'guarda chuva'), true);
  });

  it('erro de digitação tolerado só em palavras longas', () => {
    // 8+ letras: tolera 1 typo
    assert.equal(matches(card('Liquidificador'), 'liquidificadr'), true);
    // Palavras curtas: sem tolerância
    assert.equal(matches(card('Peixe'), 'peixeX'), false);
  });

  it('resposta errada não casa', () => {
    assert.equal(matches(card('Pizza'), 'lasanha'), false);
    assert.equal(matches(card('Pizza'), 'pizzaria'), false);
    assert.equal(matches(card('Sol'), 'lua'), false);
  });

  it('palpite vazio não casa', () => {
    assert.equal(matches(card('Pizza'), '   '), false);
  });
});

describe('pointsForClue', () => {
  it('3 pistas valem 10/7/4', () => {
    assert.equal(pointsForClue(0), 10);
    assert.equal(pointsForClue(1), 7);
    assert.equal(pointsForClue(2), 4);
    assert.equal(pointsForClue(3), 4);
  });
});
