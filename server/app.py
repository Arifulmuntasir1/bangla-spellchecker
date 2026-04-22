"""
Bengali Spellchecker – Flask API Server
========================================
Loads the bn_BD.dic dictionary into a SymSpell instance for O(1) lookups
and fast edit-distance suggestions. Exposes a single POST /check endpoint.

Start with:
    cd server
    pip install -r requirements.txt
    python app.py
"""

import os
import re
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from symspellpy import SymSpell, Verbosity

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DICTIONARY_PATH = os.path.join(os.path.dirname(__file__), "..", "bn_BD.dic")
MAX_EDIT_DISTANCE = 2          # Max Damerau-Levenshtein distance for suggestions
SUGGESTION_COUNT = 5           # How many suggestions to return per word
SERVER_PORT = 5111

# ---------------------------------------------------------------------------
# SymSpell Initialization
# ---------------------------------------------------------------------------
sym_spell = SymSpell(max_dictionary_edit_distance=MAX_EDIT_DISTANCE, prefix_length=7)

def load_dictionary(path: str) -> int:
    """
    Load the bn_BD.dic file into SymSpell.
    The .dic format has a word count on line 1, then one word per line.
    SymSpell needs (word, frequency) pairs – since we have no frequency data
    we assign a uniform frequency of 1 to every word.
    """
    count = 0
    abs_path = os.path.abspath(path)
    print(f"[init] Loading dictionary from: {abs_path}")

    with open(abs_path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            word = line.strip()
            # Skip the first line (word count) and blank lines
            if line_no == 1 or not word:
                continue
            # Create the entry with frequency = 1
            sym_spell.create_dictionary_entry(word, 1)
            count += 1

    print(f"[init] Loaded {count:,} words into SymSpell")
    return count

# Load once at startup
load_dictionary(DICTIONARY_PATH)

# ---------------------------------------------------------------------------
# Flask App
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)   # Allow requests from the Chrome Extension (any origin)

# Bengali word tokenizer: matches sequences of Bengali characters
# Unicode range for Bengali: \u0980-\u09FF
BENGALI_WORD_RE = re.compile(r"[\u0980-\u09FF]+")


# ---------------------------------------------------------------------------
# Suggestion Ranking
# ---------------------------------------------------------------------------
def rank_suggestions(input_word: str, suggestions: list) -> list:
    """
    Re-rank SymSpell suggestions for better relevance.

    Problem: When all dictionary words have frequency=1 (no frequency data),
    SymSpell returns suggestions with the same edit distance in arbitrary
    order. This often pushes the most likely correction far down the list.

    Solution: Score each suggestion using multiple heuristics:
      1. Edit distance (lower is better) — primary sort
      2. Consonant skeleton matching (Bengali-specific)
      3. Same-length single-substitution bonus
      4. Positional character matching
      5. Longest common prefix / suffix
      6. Character & bigram overlap ratios
      7. Length similarity

    This dramatically improves suggestion relevance for Bengali text,
    especially for vowel-sign errors (e.g. ূ vs ু, ি vs ী).
    """
    if not suggestions:
        return []

    input_chars = set(input_word)
    input_len = len(input_word)

    # Build character bigrams for the input
    input_bigrams = set()
    for i in range(len(input_word) - 1):
        input_bigrams.add(input_word[i:i+2])

    # --- Bengali consonant skeleton ---
    # Extract consonants (U+0995 to U+09B9) and hasanta (U+09CD).
    # In Bengali, consonants carry the word's identity; vowel signs are
    # the most common source of typos. Words with the same consonant
    # skeleton are almost certainly the intended correction.
    def consonant_skeleton(word):
        return ''.join(
            c for c in word
            if '\u0995' <= c <= '\u09B9' or c == '\u09CD'  # consonants + hasanta
        )

    input_skeleton = consonant_skeleton(input_word)

    scored = []
    for s in suggestions:
        term = s.term
        dist = s.distance
        term_chars = set(term)
        term_len = len(term)

        # --- Heuristic 1: Longest common prefix ---
        prefix_len = 0
        for a, b in zip(input_word, term):
            if a == b:
                prefix_len += 1
            else:
                break

        # --- Heuristic 2: Longest common suffix ---
        suffix_len = 0
        for a, b in zip(reversed(input_word), reversed(term)):
            if a == b:
                suffix_len += 1
            else:
                break

        # --- Heuristic 3: Character overlap (Jaccard-like) ---
        if input_chars or term_chars:
            char_overlap = len(input_chars & term_chars) / len(input_chars | term_chars)
        else:
            char_overlap = 0.0

        # --- Heuristic 4: Bigram overlap (Dice coefficient) ---
        term_bigrams = set()
        for i in range(len(term) - 1):
            term_bigrams.add(term[i:i+2])
        if input_bigrams or term_bigrams:
            bigram_overlap = 2 * len(input_bigrams & term_bigrams) / (len(input_bigrams) + len(term_bigrams)) if (len(input_bigrams) + len(term_bigrams)) > 0 else 0
        else:
            bigram_overlap = 0.0

        # --- Heuristic 5: Length similarity ---
        len_diff = abs(input_len - term_len)
        len_bonus = 1.0 / (1.0 + len_diff)  # 1.0 for same length, decays

        # --- Heuristic 6: Same-length substitution bonus ---
        substitution_bonus = 0.0
        if term_len == input_len:
            diffs = sum(1 for a, b in zip(input_word, term) if a != b)
            if diffs == 1:
                substitution_bonus = 8.0
            elif diffs == 2:
                substitution_bonus = 4.0

        # --- Heuristic 7: Positional character match ratio ---
        min_len = min(input_len, term_len)
        if min_len > 0:
            pos_matches = sum(1 for a, b in zip(input_word, term) if a == b)
            positional_ratio = pos_matches / max(input_len, term_len)
        else:
            positional_ratio = 0.0

        # --- Heuristic 8: Consonant skeleton match (Bengali-specific) ---
        # If the consonant structure is identical, this is almost certainly
        # the right correction (the user just got a vowel sign wrong).
        term_skeleton = consonant_skeleton(term)
        skeleton_bonus = 0.0
        if input_skeleton and term_skeleton:
            if input_skeleton == term_skeleton:
                skeleton_bonus = 12.0  # Very strong — same consonants
            elif input_skeleton.startswith(term_skeleton) or term_skeleton.startswith(input_skeleton):
                skeleton_bonus = 5.0   # One is a prefix of the other

        # --- Composite score (higher = better) ---
        score = (
            -dist * 10.0               # Edit distance is the primary factor
            + skeleton_bonus            # Consonant skeleton match (Bengali-specific)
            + substitution_bonus        # Bonus for single-char substitutions
            + positional_ratio * 5.0    # How well chars align position-by-position
            + prefix_len * 3.0          # Shared prefix (first consonant match is key)
            + suffix_len * 1.5          # Shared suffix (Bengali inflections)
            + char_overlap * 2.0        # Character set overlap
            + bigram_overlap * 2.0      # Sequential character pair overlap
            + len_bonus * 1.5           # Length similarity
        )

        scored.append((score, term, dist))

    # Sort by score descending, then by term length (prefer shorter/simpler words)
    scored.sort(key=lambda x: (-x[0], len(x[1])))

    return scored


@app.route("/check", methods=["POST"])
def check():
    """
    POST /check
    -----------
    Accepts: { "text": "কিছু বাংলা টেক্সট" }
    Returns: {
        "errors": [
            {
                "word": "টেক্সট",
                "start": 10,
                "end": 17,
                "suggestions": ["টেক্সট", ...]
            },
            ...
        ]
    }
    """
    data = request.get_json(force=True)
    text = data.get("text", "")

    if not text:
        return jsonify({"errors": []})

    errors = []

    # Find every Bengali word and its position in the original string
    for match in BENGALI_WORD_RE.finditer(text):
        word = match.group()
        start = match.start()
        end = match.end()

        # ---- Step 1: Quick exact-match check ----
        # Use CLOSEST first for speed — if distance=0, word is correct
        exact_check = sym_spell.lookup(
            word,
            Verbosity.CLOSEST,
            max_edit_distance=MAX_EDIT_DISTANCE,
        )

        if exact_check and exact_check[0].distance == 0:
            continue  # Word is correct, skip

        # ---- Step 2: Get ALL suggestions for ranking ----
        # Verbosity.ALL returns every candidate within edit distance,
        # giving us the full pool to re-rank intelligently
        all_suggestions = sym_spell.lookup(
            word,
            Verbosity.ALL,
            max_edit_distance=MAX_EDIT_DISTANCE,
        )

        # ---- Step 3: Re-rank suggestions ----
        ranked = rank_suggestions(word, all_suggestions)

        # Deduplicate and take top N
        seen = set()
        suggestion_words = []
        for _, term, _ in ranked:
            if term not in seen:
                seen.add(term)
                suggestion_words.append(term)
                if len(suggestion_words) >= SUGGESTION_COUNT:
                    break

        errors.append({
            "word": word,
            "start": start,
            "end": end,
            "suggestions": suggestion_words,
        })

    return jsonify({"errors": errors})


@app.route("/health", methods=["GET"])
def health():
    """Simple health-check endpoint."""
    return jsonify({"status": "ok", "dictionary_size": len(sym_spell.words)})


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[server] Bengali Spellchecker API running on http://localhost:{SERVER_PORT}")
    app.run(host="127.0.0.1", port=SERVER_PORT, debug=False)
