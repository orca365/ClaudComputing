const express = require('express');
const formidable = require('formidable');
const fs = require('fs/promises');
const app = express();
const PORT = 3000;

const Timer = require('./Timer');
const CloneDetector = require('./CloneDetector');
const CloneStorage = require('./CloneStorage');
const FileStorage = require('./FileStorage');


// Express and Formidable stuff to receice a file for further processing
// --------------------
const form = formidable({multiples:false});

app.post('/', fileReceiver );
function fileReceiver(req, res, next) {
    form.parse(req, (err, fields, files) => {
        fs.readFile(files.data.filepath, { encoding: 'utf8' })
            .then( data => { return processFile(fields.name, data); });
    });
    return res.end('');
}

app.get('/', viewClones );
app.get('/timers', viewTimers);

const server = app.listen(PORT, () => { console.log('Listening for files on port', PORT); });


// Page generation for viewing current progress
// --------------------
function getStatistics() {
    let cloneStore = CloneStorage.getInstance();
    let fileStore = FileStorage.getInstance();
    let output = 'Processed ' + fileStore.numberOfFiles + ' files containing ' + cloneStore.numberOfClones + ' clones.'
    return output;
}

function lastFileTimersHTML() {
    if (!lastFile) return '';
    output = '<p>Timers for last file processed:</p>\n<ul>\n'
    let timers = Timer.getTimers(lastFile);
    for (t in timers) {
        output += '<li>' + t + ': ' + (timers[t] / (1000n)) + ' µs\n'
    }
    output += '</ul>\n';
    return output;
}

function listClonesHTML() {
    let cloneStore = CloneStorage.getInstance();
    let output = '';

    cloneStore.clones.forEach( clone => {
        output += '<hr>\n';
        output += '<h2>Source File: ' + clone.sourceName + '</h2>\n';
        output += '<p>Starting at line: ' + clone.sourceStart + ' , ending at line: ' + clone.sourceEnd + '</p>\n';
        output += '<ul>';
        clone.targets.forEach( target => {
            output += '<li>Found in ' + target.name + ' starting at line ' + target.startLine + '\n';            
        });
        output += '</ul>\n'
        output += '<h3>Contents:</h3>\n<pre><code>\n';
        output += clone.originalCode;
        output += '</code></pre>\n';
    });

    return output;
}

function listProcessedFilesHTML() {
    let fs = FileStorage.getInstance();
    let output = '<HR>\n<H2>Processed Files</H2>\n'
    output += fs.filenames.reduce( (out, name) => {
        out += '<li>' + name + '\n';
        return out;
    }, '<ul>\n');
    output += '</ul>\n';
    return output;
}

function viewClones(req, res, next) {
    let page='<HTML><HEAD><TITLE>CodeStream Clone Detector</TITLE></HEAD>\n';
    page += '<BODY><H1>CodeStream Clone Detector</H1>\n';
    page += '<P>' + getStatistics() + '</P>\n';
    page += '<P><A href="/timers">View timing statistics</A></P>\n';
    page += lastFileTimersHTML() + '\n';
    page += listClonesHTML() + '\n';
    page += listProcessedFilesHTML() + '\n';
    page += '</BODY></HTML>';
    res.send(page);
}
function viewTimers(req, res, next) {
    let page = '<HTML><HEAD><TITLE>Timer Statistics</TITLE>';
    page += '<META http-equiv="refresh" content="' + REFRESH_SECONDS + '">';
    page += '<STYLE>body{font-family:sans-serif;margin:16px} .chart{max-width:900px;margin-bottom:24px}</STYLE>';
    page += '</HEAD>';
    page += '<BODY>';
    page += '<H1>Timer Statistics</H1>';

    page += '<P>' + getStatistics() + ' Measurements collected: ' +
        timerHistory.length + '. Page refreshes every ' + REFRESH_SECONDS + ' seconds.</P>';
    page += '<P><A href="/">Back to clones</A></P>';

    page += timerSummaryHTML();
    page += timerChartsHTML();

    // Only the most recent files; listing every file makes the page grow without bound.
    let names = timerNames();
    page += '<H2>Last ' + LAST_FILES_SHOWN + ' files</H2>';
    page += '<TABLE border="1">';
    page += '<TR>';
    page += '<TH>File #</TH>';
    page += '<TH>File</TH>';
    page += '<TH>Lines</TH>';
    names.forEach(timerName => {
        page += '<TH>' + escapeHTML(timerName) + ' (µs)</TH>';
    });
    page += '<TH>match per line (µs)</TH>';
    page += '</TR>';

    timerHistory.slice(-LAST_FILES_SHOWN).reverse().forEach(entry => {
        page += '<TR>';
        page += '<TD>' + entry.fileNumber + '</TD>';
        page += '<TD>' + escapeHTML(entry.fileName) + '</TD>';
        page += '<TD>' + entry.lines + '</TD>';
        names.forEach(timerName => {
            page += '<TD>' + timerToMicros(entry.timers[timerName]) + '</TD>';
        });
        page += '<TD>' + matchMicrosPerLine([entry]) + '</TD>';
        page += '</TR>';
    });

    page += '</TABLE>';

    page += '<P><A href="/">Back to clones</A></P>';
    page += '</BODY></HTML>';

    res.send(page);
}

// Some helper functions
// --------------------
// PASS is used to insert functions in a Promise stream and pass on all input parameters untouched.
PASS = fn => d => {
    try {
        fn(d);
        return d;
    } catch (e) {
        throw e;
    }
};

const STATS_FREQ = 100;
const URL = process.env.URL || 'http://localhost:8080/';
var lastFile = null;
var timerHistory = [];
const LAST_FILES_SHOWN = 20;
const MAX_CHART_POINTS = 200;  // Charts never get more points than this, however many files are processed
const REFRESH_SECONDS = 15;

function timerToMicros(timer) {
    return timer === undefined ? '' : (timer / 1000n);
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function timerNames() {
    let names = [];
    let seen = {};

    timerHistory.forEach(entry => {
        Object.keys(entry.timers).forEach(name => {
            if (!seen[name]) {
                seen[name] = true;
                names.push(name);
            }
        });
    });

    return names;
}

function averageTimerMicros(history, timerName) {
    let count = 0n;
    let total = 0n;

    history.forEach(entry => {
        if (entry.timers[timerName] !== undefined) {
            count += 1n;
            total += entry.timers[timerName];
        }
    });

    return count ? (total / count / 1000n) : '';
}

function timerSummaryHTML() {
    let names = timerNames();
    if (timerHistory.length == 0 || names.length == 0) return '';

    let windows = [
        { label: 'All files', history: timerHistory },
        { label: 'Last 100 files', history: timerHistory.slice(-100) },
        { label: 'Last 1000 files', history: timerHistory.slice(-1000) }
    ];

    let output = '<H2>Averages</H2>';
    output += '<TABLE border="1">';
    output += '<TR><TH>Range</TH><TH>Files</TH>';
    names.forEach(name => {
        output += '<TH>' + escapeHTML(name) + ' avg (µs)</TH>';
    });
    output += '<TH>match per line (µs)</TH>';
    output += '</TR>';

    windows.forEach(window => {
        output += '<TR>';
        output += '<TD>' + window.label + '</TD>';
        output += '<TD>' + window.history.length + '</TD>';
        names.forEach(name => {
            output += '<TD>' + averageTimerMicros(window.history, name) + '</TD>';
        });
        output += '<TD>' + matchMicrosPerLine(window.history) + '</TD>';
        output += '</TR>';
    });

    output += '</TABLE>';
    return output;
}

// Match time normalised for file size sum(match) / sum(lines),
// so that a large file is not mistaken for a slower algorithm, and tiny files do not dominate.
function matchMicrosPerLine(history) {
    let match = 0;
    let lines = 0;

    history.forEach(entry => {
        if (entry.timers.match !== undefined) {
            match += Number(entry.timers.match) / 1000;
            lines += entry.lines;
        }
    });

    return lines ? (match / lines).toFixed(2) : '';
}

// Group the history into buckets of consecutive files and average each bucket,
// so the charts stay cheap to generate however many files have been processed.
function bucketHistory() {
    let size = Math.max(1, Math.ceil(timerHistory.length / MAX_CHART_POINTS));
    let buckets = [];

    for (let i = 0; i < timerHistory.length; i += size) {
        let slice = timerHistory.slice(i, i + size);
        let last = slice[slice.length - 1];
        buckets.push({
            fileNumber: last.fileNumber,
            total: Number(averageTimerMicros(slice, 'total')),
            match: Number(averageTimerMicros(slice, 'match')),
            perLine: Number(matchMicrosPerLine(slice)),
            clones: last.clones,
            memory: last.memory
        });
    }

    return { size: size, buckets: buckets };
}

function timerChartsHTML() {
    if (timerHistory.length == 0) return '';
    let bucketed = bucketHistory();

    let output = '<H2>Trends</H2>';
    output += '<P>Each point is the average of ' + bucketed.size + ' consecutive file(s).</P>';
    output += '<H3>Processing time per file</H3><DIV class="chart"><CANVAS id="timeChart"></CANVAS></DIV>';
    output += '<H3>Match time per line (normalised for file size)</H3><DIV class="chart"><CANVAS id="perLineChart"></CANVAS></DIV>';
    output += '<H3>Clones found so far</H3><DIV class="chart"><CANVAS id="cloneChart"></CANVAS></DIV>';
    let now = memoryUsageMB();
    output += '<H3>Memory usage</H3><P>Now: heap used ' + now.heapUsed + ' MB of ' + now.heapTotal +
        ' MB allocated, process total (RSS) ' + now.rss + ' MB.</P>';
    output += '<DIV class="chart"><CANVAS id="memoryChart"></CANVAS></DIV>';

    output += '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>\n';
    output += '<script>\n';
    output += 'const buckets = ' + JSON.stringify(bucketed.buckets) + ';\n';
    output += `
const labels = buckets.map(b => b.fileNumber);
function lineChart(id, yTitle, datasets) {
    new Chart(document.getElementById(id), {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: { animation: false, pointRadius: 0,
                   scales: { x: { title: { display: true, text: 'Files processed' } },
                             y: { title: { display: true, text: yTitle }, beginAtZero: true } } }
    });
}
if (window.Chart) {
    lineChart('timeChart', 'µs per file', [
        { label: 'total', data: buckets.map(b => b.total) },
        { label: 'match', data: buckets.map(b => b.match) } ]);
    lineChart('perLineChart', 'µs per line', [
        { label: 'match per line', data: buckets.map(b => b.perLine) } ]);
    lineChart('cloneChart', 'clones', [
        { label: 'clones found', data: buckets.map(b => b.clones) } ]);
    lineChart('memoryChart', 'MB', [
        { label: 'heap used', data: buckets.map(b => b.memory.heapUsed) },
        { label: 'heap allocated', data: buckets.map(b => b.memory.heapTotal) },
        { label: 'process total (RSS)', data: buckets.map(b => b.memory.rss) } ]);
}
`;
    output += '</script>\n';
    return output;
}

// Memory of the Node process in MB. heapUsed is what our JavaScript objects (files, chunks, clones) occupy,
// rss is everything the process holds from the operating system.
function memoryUsageMB() {
    let mem = process.memoryUsage();
    return {
        heapUsed: Number((mem.heapUsed / 1048576).toFixed(1)),
        heapTotal: Number((mem.heapTotal / 1048576).toFixed(1)),
        rss: Number((mem.rss / 1048576).toFixed(1))
    };
}

function storeTimerHistory(file, fileNumber) {
    let timers = Timer.getTimers(file);
    let storedTimers = {};

    Object.keys(timers).forEach(timerName => {
        storedTimers[timerName] = timers[timerName];
    });

    timerHistory.push({
        fileNumber: fileNumber,
        fileName: file.name,
        // file.lines has been pruned by storeFile(), so count lines from the original contents
        lines: file.contents.split('\n').length,
        clones: CloneStorage.getInstance().numberOfClones,
        memory: memoryUsageMB(),
        timers: storedTimers
    });

    return file;
}

function maybePrintStatistics(file, cloneDetector, cloneStore) {
    if (0 == cloneDetector.numberOfProcessedFiles % STATS_FREQ) {
        console.log('Processed', cloneDetector.numberOfProcessedFiles, 'files and found', cloneStore.numberOfClones, 'clones.');
        let timers = Timer.getTimers(file);
        let str = 'Timers for last file processed: ';
        for (t in timers) {
            str += t + ': ' + (timers[t] / (1000n)) + ' µs '
        }
        console.log(str);
        console.log('List of found clones available at', URL);
    }

    return file;
}

// Processing of the file
// --------------------
function processFile(filename, contents) {
    let cd = new CloneDetector();
    let cloneStore = CloneStorage.getInstance();

    return Promise.resolve({name: filename, contents: contents} )
        //.then( PASS( (file) => console.log('Processing file:', file.name) ))
        .then( (file) => Timer.startTimer(file, 'total') )
        .then( (file) => cd.preprocess(file) )
        .then( (file) => cd.transform(file) )

        .then( (file) => Timer.startTimer(file, 'match') )
        .then( (file) => cd.matchDetect(file) )
        .then( (file) => cloneStore.storeClones(file) )
        .then( (file) => Timer.endTimer(file, 'match') )

        .then( (file) => cd.storeFile(file) )
        .then( (file) => Timer.endTimer(file, 'total') )
        .then( PASS( (file) => storeTimerHistory(file, cd.numberOfProcessedFiles)))
        .then( PASS( (file) => lastFile = file ))
        .then( PASS( (file) => maybePrintStatistics(file, cd, cloneStore) ))
        .catch( console.log );
};

/*
1. Preprocessing: Remove uninteresting code, determine source and comparison units/granularities
2. Transformation: One or more extraction and/or transformation techniques are applied to the preprocessed code to obtain an intermediate representation of the code.
3. Match Detection: Transformed units (and/or metrics for those units) are compared to find similar source units.
4. Formatting: Locations of identified clones in the transformed units are mapped to the original code base by file location and line number.
5. Post-Processing and Filtering: Visualisation of clones and manual analysis to filter out false positives
6. Aggregation: Clone pairs are aggregated to form clone classes or families, in order to reduce the amount of data and facilitate analysis.
*/
