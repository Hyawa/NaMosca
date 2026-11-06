// Port de server/tests/Unit/StrTest.php
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeAnswer, normalizeName, shortName } from '../../src/support/str.js';

describe('normalizeAnswer', () => {
  it('normaliza minúsculas e acentos', () => {
    assert.equal(normalizeAnswer('Pão de Queijo'), 'paodequeijo');
    assert.equal(normalizeAnswer('Açaí'), 'acai');
    assert.equal(normalizeAnswer('CORACÃO'), 'coracao');
  });

  it('remove pontuação e espaços', () => {
    assert.equal(normalizeAnswer('Guarda-Chuva!'), 'guardachuva');
    assert.equal(normalizeAnswer('guarda chuva'), 'guardachuva');
    assert.equal(normalizeAnswer('Cachorro'), 'cachorro');
  });

  it('vazio fica vazio', () => {
    assert.equal(normalizeAnswer('   '), '');
    assert.equal(normalizeAnswer(''), '');
  });
});

describe('normalizeName', () => {
  it('normaliza minúsculas e acentos mantendo um espaço', () => {
    assert.equal(normalizeName('   Van   GOGH  '), 'van gogh');
    assert.equal(normalizeName('ana    clara'), 'ana clara');
  });
});

describe('shortName', () => {
  it('corta no limite', () => {
    assert.equal([...shortName('a'.repeat(40))].length, 24);
    assert.equal(shortName('Ana'), 'Ana');
  });
});
