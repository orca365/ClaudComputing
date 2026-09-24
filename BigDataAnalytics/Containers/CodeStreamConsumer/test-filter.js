// Quick tests of CloneDetector via the public matchDetect().
//   Part A: #filterCloneCandidates   (finds matching chunks -> one Clone per chunk)
//   Part B: #expandCloneCandidates   (merges overlapping neighbouring Clones into one bigger Clone)
//   Part C: #consolidateClones       (same source lines found in several places -> one Clone, several targets)
// Run: node test-filter.js
const assert = require('assert');
const SRC = __dirname + '/src';
const CloneDetector = require(SRC + '/CloneDetector');
const Clone = require(SRC + '/Clone');
const SourceLine = require(SRC + '/SourceLine');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}
function show(title, file) {
    console.log(`\n${title}`);
    if (file.instances.length == 0) console.log('  (no clones)');
    for (const c of file.instances) {
        if (!(c instanceof Clone)) { console.log('  ', c); continue; }
        console.log(`  ${c.sourceName} lines ${c.sourceStart}-${c.sourceEnd}` +
                    `  ->  ${c.targets.map(t => t.name + ' line ' + t.startLine).join(', ')}`);
    }
}
// transform() mutates the object it gets, so always hand it a fresh copy
const fresh = f => ({ name: f.name, contents: f.contents });
const targetsOf = clone => clone.targets.map(t => [t.name, t.startLine]);
const summary = file => file.instances.map(c => [c.sourceStart, c.sourceEnd, c.targets[0].startLine]);

const cd = new CloneDetector();   // chunk size = 5 (default)

// Old file: 7 content lines -> 3 chunks (1-5, 2-6, 3-7)
const oldFile = { name: 'Old.java', contents: [
    'int a = 1;',
    'int b = 2;',
    'int c = 3;',
    'int d = 4;',
    'int e = 5;',
    'int f = 6;',
    'int g = 7;',
].join('\n') };

// New file: 2 unique lines, then the first 6 lines of Old.java (incl. a comment that must be ignored)
const newFile = { name: 'New.java', contents: [
    'String x = "hi";',
    'String y = "yo";',
    'int a = 1;',
    '// a comment, filtered away',
    'int b = 2;',
    'int c = 3;',
    'int d = 4;',
    'int e = 5;',
    'int f = 6;',
].join('\n') };

// A file with nothing in common
const otherFile = { name: 'Other.java', contents: 'q1;\nq2;\nq3;\nq4;\nq5;\nq6;' };

// Exactly the same 7 lines as Old.java -> 3 chunk clones that should merge into 1
const copyFile = { name: 'Copy.java', contents: oldFile.contents };

// Two separate copied blocks with unrelated code in between -> 2 clones that must NOT merge
const twoBlocksFile = { name: 'TwoBlocks.java', contents: [
    'int a = 1;',        // 1  \
    'int b = 2;',        // 2   |
    'int c = 3;',        // 3   | block 1 = Old.java lines 1-5
    'int d = 4;',        // 4   |
    'int e = 5;',        // 5  /
    'foo();',            // 6
    'bar();',            // 7
    'baz();',            // 8
    'int c = 3;',        // 9  \
    'int d = 4;',        // 10  |
    'int e = 5;',        // 11  | block 2 = Old.java lines 3-7
    'int f = 6;',        // 12  |
    'int g = 7;',        // 13 /
].join('\n') };

cd.storeFile(cd.transform(fresh(oldFile)));   // Old.java is the only stored file for all tests below

// ============================================================
console.log('=== Part A: filterCloneCandidates ===');
// ============================================================
// Before expansion New.java gives two chunk clones: [3-8 -> Old 1] and [5-9 -> Old 2].
// They overlap, so after expansion they must be merged into one: [3-9 -> Old 1].
let result = cd.matchDetect(cd.transform(fresh(newFile)));
show('New.java vs Old.java:', result);
check('all clones go from New.java to Old.java', () =>
    assert.ok(result.instances.every(c => c.sourceName === 'New.java' && c.targets[0].name === 'Old.java')));

result = cd.matchDetect(cd.transform(fresh(otherFile)));
show('Other.java vs Old.java:', result);
check('no common code -> empty array', () =>
    assert.deepStrictEqual(result.instances, []));

// ============================================================
console.log('\n=== Part B: expandCloneCandidates ===');
// ============================================================

// B1: the New.java case from Part A
result = cd.matchDetect(cd.transform(fresh(newFile)));
check('B1 New.java: overlapping clones 3-8 and 5-9 merge into 3-9', () =>
    assert.deepStrictEqual(summary(result), [[3, 9, 1]],
        'got ' + JSON.stringify(summary(result)) + '  (unexpanded would be [[3,8,1],[5,9,2]])'));

// B2: three overlapping chunks in a row -> one clone covering everything
result = cd.matchDetect(cd.transform(fresh(copyFile)));
show('Copy.java vs Old.java:', result);
check('B2 Copy.java: chunks 1-5, 2-6, 3-7 merge into one clone 1-7', () =>
    assert.deepStrictEqual(summary(result), [[1, 7, 1]],
        'got ' + JSON.stringify(summary(result)) + '  (unexpanded would be [[1,5,1],[2,6,2],[3,7,3]])'));
check('B2 expanded clone holds all 7 source lines, no duplicates', () =>
    assert.deepStrictEqual(result.instances[0].sourceChunk.map(l => l.lineNumber), [1, 2, 3, 4, 5, 6, 7]));

// B3: two separate blocks must stay two clones
result = cd.matchDetect(cd.transform(fresh(twoBlocksFile)));
show('TwoBlocks.java vs Old.java:', result);
check('B3 TwoBlocks.java: non-adjacent clones stay separate (1-5 and 9-13)', () =>
    assert.deepStrictEqual(summary(result), [[1, 5, 1], [9, 13, 3]],
        'got ' + JSON.stringify(summary(result))));

// B4: clones already in file.instances are kept, and new ones are still expanded
const f = cd.transform(fresh(newFile));
const earlier = new Clone('New.java', 'Earlier.java',
    [100, 101, 102, 103, 104].map(n => new SourceLine(n, 'x' + n)),
    [1, 2, 3, 4, 5].map(n => new SourceLine(n, 'x' + n)));
f.instances = [earlier];
result = cd.matchDetect(f);
show('New.java with one pre-existing clone (lines 100-104):', result);
check('B4 pre-existing clone kept, new clones still expanded', () =>
    assert.deepStrictEqual(summary(result), [[100, 104, 1], [3, 9, 1]],
        'got ' + JSON.stringify(summary(result))));

// ============================================================
console.log('\n=== Part C: consolidateClones ===');
// ============================================================
// Each Part C test stores its own files with unique contents, so they don't match Old.java or each other.

// C1: code copied TWICE into the same old file -> one clone with 2 targets in that file
const dupFile = { name: 'Dup.java', contents: [
    'm1;', 'm2;', 'm3;', 'm4;', 'm5;',   // 1-5   first copy
    'other1;', 'other2;', 'other3;',     // 6-8
    'm1;', 'm2;', 'm3;', 'm4;', 'm5;',   // 9-13  second copy
].join('\n') };
const dupUserFile = { name: 'DupUser.java', contents: 'm1;\nm2;\nm3;\nm4;\nm5;' };
cd.storeFile(cd.transform(fresh(dupFile)));
result = cd.matchDetect(cd.transform(fresh(dupUserFile)));
show('DupUser.java (m-block once) vs Dup.java (m-block twice):', result);
check('C1 one clone 1-5 (unconsolidated would be two identical 1-5 clones)', () =>
    assert.deepStrictEqual(result.instances.map(c => [c.sourceStart, c.sourceEnd]), [[1, 5]],
        'got ' + JSON.stringify(result.instances.map(c => [c.sourceStart, c.sourceEnd]))));
check('C1 that clone has both targets: Dup.java line 1 and line 9', () =>
    assert.deepStrictEqual(targetsOf(result.instances[0]), [['Dup.java', 1], ['Dup.java', 9]]));

// C2: code found in TWO different old files -> one clone with a target in each file
const kaFile = { name: 'KA.java', contents: 'k1;\nk2;\nk3;\nk4;\nk5;' };
const kbFile = { name: 'KB.java', contents: 'hello();\nworld();\nk1;\nk2;\nk3;\nk4;\nk5;' };  // k-block starts at line 3
const kUserFile = { name: 'KUser.java', contents: 'k1;\nk2;\nk3;\nk4;\nk5;' };
cd.storeFile(cd.transform(fresh(kaFile)));
cd.storeFile(cd.transform(fresh(kbFile)));
result = cd.matchDetect(cd.transform(fresh(kUserFile)));
show('KUser.java vs KA.java and KB.java:', result);
check('C2 one clone 1-5 with targets KA.java line 1 and KB.java line 3', () => {
    assert.strictEqual(result.instances.length, 1, 'got ' + result.instances.length + ' clones');
    assert.deepStrictEqual(targetsOf(result.instances[0]), [['KA.java', 1], ['KB.java', 3]]);
});

// C3: expand + consolidate together. A 6-line block in two files:
//     each file gives chunks 1-5 and 2-6, which expand to 1-6, then the two 1-6 clones consolidate.
const paFile = { name: 'PA.java', contents: 'p1;\np2;\np3;\np4;\np5;\np6;' };
const pbFile = { name: 'PB.java', contents: 'zz();\np1;\np2;\np3;\np4;\np5;\np6;' };  // p-block starts at line 2
const pUserFile = { name: 'PUser.java', contents: 'p1;\np2;\np3;\np4;\np5;\np6;' };
cd.storeFile(cd.transform(fresh(paFile)));
cd.storeFile(cd.transform(fresh(pbFile)));
result = cd.matchDetect(cd.transform(fresh(pUserFile)));
show('PUser.java vs PA.java and PB.java:', result);
check('C3 one expanded clone 1-6 with targets PA.java line 1 and PB.java line 2', () => {
    assert.deepStrictEqual(result.instances.map(c => [c.sourceStart, c.sourceEnd]), [[1, 6]],
        'got ' + JSON.stringify(result.instances.map(c => [c.sourceStart, c.sourceEnd])));
    assert.deepStrictEqual(targetsOf(result.instances[0]), [['PA.java', 1], ['PB.java', 2]]);
});

// C4: different source ranges must NOT be consolidated (re-run TwoBlocks.java from B3)
result = cd.matchDetect(cd.transform(fresh(twoBlocksFile)));
check('C4 TwoBlocks.java: still 2 clones, each with exactly 1 target', () => {
    assert.deepStrictEqual(summary(result), [[1, 5, 1], [9, 13, 3]], 'got ' + JSON.stringify(summary(result)));
    assert.ok(result.instances.every(c => c.targets.length == 1),
        'targets: ' + JSON.stringify(result.instances.map(targetsOf)));
});

console.log(failures ? `\n${failures} test(s) FAILED ✘` : '\nAll tests passed ✔');
process.exitCode = failures ? 1 : 0;
