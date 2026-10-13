const fs = require('fs');
const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');

// Settings
// --------------------
const DBHOST = process.env.DBHOST || 'localhost';
const DBNAME = 'cloneDetector';
const SAMPLE_SECONDS = parseInt(process.env.SAMPLE_SECONDS || '10');
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const COLLECTIONS = ['files', 'chunks', 'candidates', 'clones'];
const PORT = 3000;
const REFRESH_SECONDS = 15;
const MAX_POINTS = 200;  // charts never get more points than this, however long the run

// The first words of each cljDetector status message, and the phase it starts
const PHASES = [
    ['Reading and Processing files', 'reading'],
    ['Storing files', 'storing files'],
    ['Storing chunks', 'storing chunks'],
    ['Identifying Clone Candidates', 'identifying candidates'],
    ['Expanding Candidates', 'expanding'],
    ['Consolidating and listing clones', 'listing'],
    ['Summary', 'done'],
];

// State for the current run
// --------------------
let db;
let samples = [];        // one entry per sample, oldest first
let statusUpdates = [];  // every status message seen, oldest first
let csvFile;


// Status updates and phases
// --------------------
async function readNewStatusUpdates() {
    let lastSeen = statusUpdates.length > 0 ? statusUpdates[statusUpdates.length - 1].timestamp : new Date(0);
    let newUpdates = await db.collection('statusUpdates')
        .find({ timestamp: { $gt: lastSeen } })
        .sort({ timestamp: 1 })
        .toArray();

    for (let update of newUpdates) {
        if (update.message.startsWith('Reading and Processing files')) {
            startNewRun();
        }
        statusUpdates.push(update);
        console.log('STATUS', update.timestamp.toISOString(), update.message);
    }
}

function phaseOf(message) {
    let match = PHASES.find(([prefix]) => message.startsWith(prefix));
    return match ? match[1] : null;
}

function currentPhase() {
    for (let i = statusUpdates.length - 1; i >= 0; i--) {
        let phase = phaseOf(statusUpdates[i].message);
        if (phase) return phase;
    }
    return 'waiting';
}


// Sampling
// --------------------
async function takeSample() {
    await readNewStatusUpdates();

    let sample = { time: new Date(), phase: currentPhase() };
    for (let name of COLLECTIONS) {
        sample[name] = await db.collection(name).estimatedDocumentCount();
    }

    if (!csvFile) createCsvFile();
    samples.push(sample);
    let line = [sample.time.toISOString(), sample.phase, ...COLLECTIONS.map(name => sample[name])].join(',');
    fs.appendFileSync(csvFile, line + '\n');
    console.log('SAMPLE', line);
}

async function samplingLoop() {
    try {
        await takeSample();
    } catch (err) {
        console.error('Sample failed:', err.message);
    }
    setTimeout(samplingLoop, SAMPLE_SECONDS * 1000);
}

function startNewRun() {
    samples = [];
    statusUpdates = [];
    csvFile = null;
}

function createCsvFile() {
    let fileName = 'samples-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    csvFile = path.join(DATA_DIR, fileName);
    fs.writeFileSync(csvFile, 'time,phase,' + COLLECTIONS.join(',') + '\n');
    console.log('Writing samples to', csvFile);
}


// Statistics
// --------------------
// One interval per pair of consecutive samples: how long it took and how much each count changed
function intervals() {
    let result = [];
    for (let i = 1; i < samples.length; i++) {
        let before = samples[i - 1];
        let after = samples[i];
        let interval = { phase: after.phase, seconds: (after.time - before.time) / 1000, after: after };
        for (let name of COLLECTIONS) {
            interval[name] = after[name] - before[name];
        }
        result.push(interval);
    }
    return result;
}

// Milliseconds per new unit (e.g. per chunk) during one phase, plotted against a count (e.g. chunks so far).
// Consecutive intervals are grouped so that a chart never gets more than MAX_POINTS points.
function msPerUnit(phase, unit, xOf) {
    let selected = intervals().filter(interval => interval.phase === phase);
    let groupSize = Math.max(1, Math.ceil(selected.length / MAX_POINTS));
    let points = [];
    for (let start = 0; start < selected.length; start += groupSize) {
        let group = selected.slice(start, start + groupSize);
        let seconds = group.reduce((sum, interval) => sum + interval.seconds, 0);
        let units = group.reduce((sum, interval) => sum + interval[unit], 0);
        if (units > 0) {
            points.push({ x: xOf(group[group.length - 1].after), y: 1000 * seconds / units });
        }
    }
    return points;
}

function countsOverTime() {
    let step = Math.max(1, Math.ceil(samples.length / MAX_POINTS));
    let start = samples.length > 0 ? samples[0].time : new Date();
    let picked = samples.filter((sample, i) => i % step === 0 || i === samples.length - 1);
    return COLLECTIONS.map(name => ({
        label: name,
        points: picked.map(sample => ({ x: (sample.time - start) / 60000, y: sample[name] })),
    }));
}

function phaseDurations() {
    let starts = statusUpdates
        .map(update => ({ phase: phaseOf(update.message), time: update.timestamp }))
        .filter(start => start.phase);
    let rows = [];
    for (let i = 0; i < starts.length; i++) {
        if (starts[i].phase === 'done') continue;
        let running = i === starts.length - 1;
        let end = running ? new Date() : starts[i + 1].time;
        rows.push({ phase: starts[i].phase, minutes: (end - starts[i].time) / 60000, running: running });
    }
    return rows;
}

async function cloneStatistics() {
    let [result] = await db.collection('clones').aggregate([
        { $project: {
            instances: { $size: '$instances' },
            lines: { $avg: { $map: {
                input: '$instances',
                as: 'instance',
                in: { $add: [{ $subtract: ['$$instance.endLine', '$$instance.startLine'] }, 1] },
            } } },
        } },
        { $group: { _id: null, avgLines: { $avg: '$lines' }, avgInstances: { $avg: '$instances' } } },
    ]).toArray();
    return result || { avgLines: 0, avgInstances: 0 };
}

// During expansion: two ways to predict how long is left.
// By clone size: assumes every future clone uses up as many candidates as the clones so far.
// By candidate rate: assumes candidates keep being used up as fast as in the last few minutes.
function expansionForecast() {
    let last = samples[samples.length - 1];
    if (!last || last.phase !== 'expanding' || last.clones === 0) return null;

    let candidatesAtStart = Math.max(...samples.map(sample => sample.candidates));
    let candidatesPerClone = (candidatesAtStart - last.candidates) / last.clones;
    let remainingClones = last.candidates / candidatesPerClone;

    // The last 30 intervals, skipping the one where the candidates first appeared (their count went up)
    let recent = intervals()
        .filter(interval => interval.phase === 'expanding' && interval.candidates <= 0)
        .slice(-30);
    let seconds = recent.reduce((sum, interval) => sum + interval.seconds, 0);
    let clones = recent.reduce((sum, interval) => sum + interval.clones, 0);
    let candidatesUsed = -recent.reduce((sum, interval) => sum + interval.candidates, 0);

    return {
        candidatesPerClone: candidatesPerClone,
        remainingClones: remainingClones,
        minutesLeftByCloneSize: clones > 0 ? remainingClones * seconds / clones / 60 : null,
        candidatesPerSecond: seconds > 0 ? candidatesUsed / seconds : 0,
        minutesLeftByCandidateRate: candidatesUsed > 0 ? last.candidates * seconds / candidatesUsed / 60 : null,
    };
}


// Web page
// --------------------
const app = express();

app.get('/', async (req, res) => {
    try {
        res.send(await buildPage());
    } catch (err) {
        res.status(500).send('Could not build page: ' + err.message);
    }
});

app.get('/samples.csv', (req, res) => {
    if (!csvFile) return res.status(404).send('No samples yet');
    res.sendFile(csvFile);
});

async function buildPage() {
    let last = samples[samples.length - 1] || { phase: currentPhase(), files: 0, chunks: 0, candidates: 0, clones: 0 };
    let cloneStats = await cloneStatistics();
    let forecast = expansionForecast();
    let charts = {
        counts: countsOverTime(),
        chunks: msPerUnit('storing chunks', 'chunks', sample => sample.chunks),
        clonesByClones: msPerUnit('expanding', 'clones', sample => sample.clones),
        clonesByCandidates: msPerUnit('expanding', 'clones', sample => sample.candidates),
    };

    let page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>MonitorTool</title>';
    page += '<meta http-equiv="refresh" content="' + REFRESH_SECONDS + '">';
    page += '<style>body{font-family:sans-serif;margin:16px} table{border-collapse:collapse;margin-bottom:16px}'
        + ' td,th{border:1px solid #999;padding:4px 8px;text-align:right} .chart{max-width:900px;margin-bottom:24px}</style>';
    page += '</head><body><h1>cljDetector Monitor</h1>';
    page += '<p>Phase: <b>' + last.phase + '</b>. Sampling every ' + SAMPLE_SECONDS + ' s, ' + samples.length + ' samples. '
        + '<a href="/samples.csv">Raw samples (CSV)</a>. Page refreshes every ' + REFRESH_SECONDS + ' s.</p>';

    page += '<h2>Counts and averages</h2><table>';
    for (let name of COLLECTIONS) {
        page += row(name, last[name]);
    }
    page += row('chunks per file', last.files > 0 ? (last.chunks / last.files).toFixed(1) : '-');
    page += row('clone size (lines)', cloneStats.avgLines.toFixed(1));
    page += row('instances per clone', cloneStats.avgInstances.toFixed(2));
    if (forecast) {
        page += row('candidates used per clone (so far)', forecast.candidatesPerClone.toFixed(1));
        page += row('clones still to come (by clone size)', Math.round(forecast.remainingClones));
        page += row('expansion time left (by clone size)', minutes(forecast.minutesLeftByCloneSize));
        page += row('candidates used per second (recent)', forecast.candidatesPerSecond.toFixed(0));
        page += row('expansion time left (by candidate rate)', minutes(forecast.minutesLeftByCandidateRate));
    }
    page += '</table>';

    page += '<h2>Phase durations</h2><table><tr><th>phase</th><th>minutes</th></tr>';
    for (let phase of phaseDurations()) {
        page += row(phase.phase + (phase.running ? ' (running)' : ''), phase.minutes.toFixed(1));
    }
    page += '</table>';

    page += '<h2>Counts over time</h2><div class="chart"><canvas id="counts"></canvas></div>';
    page += '<h2>Time per chunk vs chunks already stored</h2><div class="chart"><canvas id="chunks"></canvas></div>';
    page += '<h2>Time per clone vs clones already expanded</h2><div class="chart"><canvas id="clonesByClones"></canvas></div>';
    page += '<h2>Time per clone vs candidates remaining</h2><div class="chart"><canvas id="clonesByCandidates"></canvas></div>';

    page += '<h2>Latest status messages</h2><ul>';
    for (let update of statusUpdates.slice(-10).reverse()) {
        page += '<li>' + update.timestamp.toISOString() + ' ' + update.message + '</li>';
    }
    page += '</ul>';

    page += '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>';
    page += '<script>const charts = ' + JSON.stringify(charts) + ';\n' + CHART_SCRIPT + '</script>';
    page += '</body></html>';
    return page;
}

function row(label, value) {
    return '<tr><th>' + label + '</th><td>' + value + '</td></tr>';
}

function minutes(value) {
    return value === null ? '-' : value.toFixed(1) + ' min';
}

// Runs in the browser: draws the four charts from the data embedded in the page
const CHART_SCRIPT = `
function draw(id, xTitle, yTitle, datasets, logarithmic) {
    new Chart(document.getElementById(id), {
        type: 'scatter',
        data: { datasets: datasets.map(d => ({ label: d.label, data: d.points, showLine: true, pointRadius: 2 })) },
        options: {
            animation: false,
            scales: {
                x: { title: { display: true, text: xTitle } },
                y: { type: logarithmic ? 'logarithmic' : 'linear', title: { display: true, text: yTitle } },
            },
        },
    });
}
draw('counts', 'minutes since start', 'documents (log scale)', charts.counts, true);
draw('chunks', 'chunks already stored', 'ms per chunk', [{ label: 'ms per chunk', points: charts.chunks }]);
draw('clonesByClones', 'clones already expanded', 'ms per clone', [{ label: 'ms per clone', points: charts.clonesByClones }]);
draw('clonesByCandidates', 'candidates remaining', 'ms per clone', [{ label: 'ms per clone', points: charts.clonesByCandidates }]);
`;


// Start
// --------------------
async function main() {
    let client = new MongoClient('mongodb://' + DBHOST + ':27017');
    await client.connect();
    db = client.db(DBNAME);
    console.log('Connected to MongoDB at', DBHOST);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    samplingLoop();
    app.listen(PORT, () => console.log('Monitor page on port', PORT));
}

main().catch(err => {
    console.error('MonitorTool could not start:', err.message);
    process.exit(1);
});
