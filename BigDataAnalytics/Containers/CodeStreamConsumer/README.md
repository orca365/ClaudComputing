# Working with a Stream of Data

**Course:** Big Data Analytics, Applied Cloud Computing and Big Data, BTH  
**Team:** Dawood Rahimi and Ali Reza Sharifi

## Summary

We did not process the entire Qualitas Corpus. In our main run, the consumer processed 27,554 of the corpus's 163,596 Java files (about 17%) before processing stopped making progress. The measurements show that match time rises as more files are retained. The main algorithmic causes are scanning previously stored chunks and retaining files, chunks, and clones in memory. The run also exposed a failure in the upload path: the consumer crashed when a multipart request did not contain the expected `data` file. This report describes the results, the detector implementation, and improvements that would be needed for a complete run.

## 1. Can the Entire Qualitas Corpus Be Processed?

**No, not with the implementation and run configuration measured here.** The corpus contains 163,596 Java files. Our main run processed 27,554 files and found 3,012 clones, or about 17% of the corpus. The page then stopped recording new files. We stopped the run manually at about 14:00.

### Processing and storage bottlenecks

- **Repeated full scans:** for each incoming file, `matchDetect()` scans all previously stored files and compares their chunks. As the number of stored files grows, each new file takes longer. With similar-sized files, the total work across the stream approaches quadratic growth.
- **Growing in-memory state:** `FileStorage` retains each file, its contents, and its chunks of `SourceLine` objects. `CloneStorage` also retains detected clones. The heap grew to about 590 MB at 27,500 files in one chart, and later observations during the stalled run showed heap use above 1.2 GB. Garbage collection and memory pressure therefore become increasingly important, and extrapolating memory use across the whole corpus suggests the default Node.js heap may be insufficient.
- **Upload handling:** the consumer crashed at about 22,500 files with `TypeError: Cannot read properties of undefined (reading 'filepath')` in `index.js`. The upload handler creates one Formidable parser and reuses it for all requests, instead of creating a parser per request. Repeated or concurrent requests can leave the handler in a bad state; the missing-file error was observed, while listener accumulation and interference between requests are likely explanations to verify against the installed Formidable version.
- **Temporary uploads and throughput:** uploaded temporary files were observed accumulating in `/tmp` (about 284,469 files / 835 MB in the stalled run). The generator can also send work faster than a memory-bound consumer can safely process it.

### Changes needed for a full-corpus run

1. Index chunks by a deterministic content hash so new chunks look up matching occurrences rather than scanning every previous chunk.
2. Move file/chunk indexes and clone results to persistent, indexed storage; keep only a bounded working set in memory.
3. Create a Formidable parser per request, validate the parsed file and fields, return a client error for malformed uploads, and delete each temporary upload after processing.
4. Add a queue or backpressure so the generator waits for capacity or for processing to complete before sending more files.
5. Benchmark the revised system on the target machine, measuring throughput, peak memory, temporary-disk use, and correctness before claiming that the full corpus completes.

The run results and screenshots are included below:

| Run | Result |
|---|---|
| First run | Crashed at about 22,500 files with the missing `files.data.filepath` error. |
| Short run | 1,366 files; 46 clones. |
| Main run | 27,554 files; 3,012 clones by about 12:45. No new files appeared afterward; the run was stopped manually at about 14:00. |

![Main clones page](screenshots/01-clones-page.png)

![Memory during the stall](screenshots/05-memory-at-stall.png)

![Memory later in the run](screenshots/06-memory-later.png)

## 2. Reducing SourceLine Comparisons

Comparing two chunks line by line can require `CHUNKSIZE` `SourceLine` comparisons. The current `#chunkMatch()` also continues through the loop after a mismatch; it can immediately return `false` on the first unequal line.

A larger improvement is to compute a deterministic hash from the ordered line contents of each chunk and index prior chunks by that hash. A new chunk then performs a map lookup rather than being compared with every old chunk. Store the file and line locations for each hash so matching occurrences can be reported. To guarantee exact matching despite possible hash collisions, compare the original lines only among chunks with the same hash.

## 3. Processing-Time Trends

The measurements show that processing time per file increases with the number of files already processed:

| Measurement | 1,366-file run | 27,554-file run | Approximate change |
|---|---:|---:|---:|
| Average total time, all files | 3.1 ms | 42.2 ms | 13x |
| Average match time, last 1,000 files | 3.4 ms | 67.2 ms | 20x |
| Match time per line, last 1,000 files | 17.0 µs | 336.4 µs | 20x |
| Average match time, last 100 files | 4.9 ms | 159.4 ms | 32x |

With 20 times as many stored files, the average match time over the last 1,000 files was about 20 times higher. This is consistent with work per incoming file growing roughly linearly with the number of previously stored files; total work over the stream consequently trends toward O(n²). Small files also pay a fixed cost for visiting all stored files, even when none of their chunks match.

The last-100 average rises more sharply because a few slow files had many matching chunks. Clone expansion and consolidation repeatedly search candidate lists, so files producing many candidates can create additional spikes. The memory charts show a rising heap footprint; garbage collection and memory pressure are plausible contributors to irregular delays. These are interpretations of the observed data, not proof that every individual spike has the same cause.

![Processing time per file](screenshots/03-time-per-file.png)

![Clone count during the run](screenshots/04-clones-found.png)

![Averages from the short run](screenshots/08-averages-1366.png)

![Averages from the main run](screenshots/02-averages-27554.png)

## 4. Code Submission

The submission is the complete `Containers/CodeStreamConsumer` directory, including its Dockerfile, package manifest, source files, tests, and screenshots. From the `BigDataAnalytics` repository root, create the requested archive with:

```sh
zip -r CodeStreamConsumer.zip Containers/CodeStreamConsumer
```

Upload `CodeStreamConsumer.zip` to the assignment submission page. Creating the archive locally does not itself submit it to the course site.

## Implementation and Accuracy Notes

### CloneDetector implementation

The detector filters blank lines and comments, makes sliding windows of `CHUNKSIZE` non-empty lines, finds equal chunks, expands overlapping matches, and consolidates matches with the same source range into clone records with multiple targets. `#filterCloneCandidates()` keeps prior results by appending new matches; `#expandCloneCandidates()` merges adjacent source windows; `#consolidateClones()` groups repeated source ranges. The implementation is exercised by `test-filter.js`, which covers matching, expansion, separate clone blocks, and consolidation. The report's recorded test run had 12 checks passing.

### Accuracy and limitations

The detector identifies exact matches of normalized line text; it is not a full Java parser. It can miss clones with renamed identifiers or meaningful formatting changes, and common boilerplate can produce unhelpful matches. Expansion checks source-line adjacency but does not ensure that the matching target ranges are adjacent, which can produce an incorrectly expanded result. These limitations should be considered when evaluating clone accuracy.

### Timing page

The `/timers` page reports total and match time, match time normalized by source line count, clone count, and process memory. It shows averages for all collected data and recent windows, trend charts capped at 200 points, and the most recent 20 files. This makes growth and outliers easier to inspect without generating a page that grows with every processed file.

The timing samples are in-memory observations from these runs; the screenshots document the reported measurements. A future run should preserve raw measurements and record its machine/runtime configuration so results can be reproduced and compared.