class Clone {

    constructor(sourceName, targetName, sourceChunk, targetChunk) {
        this.sourceName = sourceName;
        this.sourceStart = sourceChunk[0].lineNumber;
        this.sourceEnd = sourceChunk[sourceChunk.length -1].lineNumber;
        this.sourceChunk = sourceChunk;// save actuall maching source line[20,21,22,23.....]

        this.targets = [{ name: targetName, startLine: targetChunk[0].lineNumber }];
    }

    equals(clone) {
        return this.sourceName == clone.sourceName &&
            this.sourceStart == clone.sourceStart &&
            this.sourceEnd == clone.sourceEnd;
    }

    addTarget(clone) {
        this.targets = this.targets.concat(clone.targets);
    }

    isNext(clone) {
        // Clone 1: 1 2 3 4 5
        // Clone 2:   2 3 4 5 6
        /*
        Return 5 == 5    which is the last element for Clone 1. and clone.sourcechunk.length -2 is index 3 and element next last.
        this shows the overlapping sliding window clone.
         */
        return (this.sourceChunk[this.sourceChunk.length-1].lineNumber == 
                clone.sourceChunk[clone.sourceChunk.length-2].lineNumber);
    }

    maybeExpandWith(clone) {
        /*Clone 1: 1 2 3 4 5 and Clone 2: 2 3 4 5 6 --> combine gives 1 2 3 4 5 2 3 4 5 6 set return 1 2 3 4 5 6 and sourceEnd = 6*/
        if (this.isNext(clone)) {
            this.sourceChunk = [...new Set([...this.sourceChunk, ...clone.sourceChunk])]; // set remove dublicate value
            this.sourceEnd = this.sourceChunk[this.sourceChunk.length-1].lineNumber;
            //console.log('Expanded clone, now starting at', this.sourceStart, 'and ending at', this.sourceEnd);
            return true;
        } else {
            return false;
        }
    }
}

module.exports = Clone;
