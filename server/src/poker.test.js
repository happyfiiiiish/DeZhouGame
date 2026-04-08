import assert from "node:assert/strict";
import test from "node:test";

import { compareHandStrength, createDeck, evaluateSevenCardHand, shuffleDeck } from "./poker.js";

test("createDeck builds a full 52-card deck without duplicates", () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test("shuffleDeck keeps all original cards", () => {
  const deck = createDeck();
  const shuffled = shuffleDeck(deck, () => 0.5);
  assert.equal(shuffled.length, deck.length);
  assert.deepEqual([...shuffled].sort(), [...deck].sort());
});

test("evaluateSevenCardHand detects a straight flush", () => {
  const result = evaluateSevenCardHand(["AS", "KS", "QS", "JS", "TS", "2D", "3C"]);
  assert.equal(result.category, 8);
  assert.deepEqual(result.bestCards, ["AS", "KS", "QS", "JS", "TS"]);
});

test("evaluateSevenCardHand detects wheel straight", () => {
  const result = evaluateSevenCardHand(["AS", "2H", "3D", "4C", "5S", "KD", "QH"]);
  assert.equal(result.category, 4);
  assert.deepEqual(result.tiebreak, [5]);
});

test("compareHandStrength compares kickers when both players have a pair", () => {
  const left = evaluateSevenCardHand(["AH", "AD", "KS", "QC", "9D", "4S", "2H"]);
  const right = evaluateSevenCardHand(["AC", "AS", "QS", "JD", "9H", "4C", "2D"]);
  assert.equal(compareHandStrength(left, right), 1);
});

test("evaluateSevenCardHand prefers the strongest five-card combination from the board", () => {
  const result = evaluateSevenCardHand(["2S", "2D", "AH", "KH", "QH", "JH", "TH"]);
  assert.equal(result.category, 8);
  assert.deepEqual(result.bestCards, ["AH", "KH", "QH", "JH", "TH"]);
});
