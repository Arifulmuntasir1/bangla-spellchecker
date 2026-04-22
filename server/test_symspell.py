import os
import re
from symspellpy import SymSpell, Verbosity

sym_spell = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
path = os.path.join(os.path.dirname(__file__), "..", "bn_BD.dic")
abs_path = os.path.abspath(path)

with open(abs_path, "r", encoding="utf-8") as f:
    for line_no, line in enumerate(f, start=1):
        word = line.strip()
        if line_no == 1 or not word:
            continue
        sym_spell.create_dictionary_entry(word, 1)

print("Loaded:", len(sym_spell.words))

test_text = "আমি বাংলায় লিখছি তবে এখানে ভূল আছে"
BENGALI_WORD_RE = re.compile(r"[\u0980-\u09FF]+")

for match in BENGALI_WORD_RE.finditer(test_text):
    word = match.group()
    suggestions = sym_spell.lookup(word, Verbosity.CLOSEST, max_edit_distance=2)
    print(f"Word: {word}")
    for s in suggestions:
        print(f"  - {s.term}, dist: {s.distance}")
    if suggestions and suggestions[0].distance == 0:
        print("  => CORRECT")
    else:
        print("  => INCORRECT")

