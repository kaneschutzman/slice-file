var fs = require('fs');
var through = require('through');
var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var split = require('split');

var nextTick = typeof setImmediate === 'function'
    ? setImmediate
    : process.nextTick
;

module.exports = function (file, opts) {
    if (!opts) opts = {};
    if (opts.flags === undefined) opts.flags = 'r';
    if (opts.mode === undefined) opts.mode = 0666;
    
    var fa = new FA(file, opts);
    
    if (opts.fd === undefined) {
        fs.open(file, opts.flags, opts.mode, function (err, fd) {
            if (err) return fa.emit('error', err)
            fa.fd = fd;
            fa.emit('open', fd)
        });
    }
    return fa;
};

function FA (file, opts) {
    this.file = file;
    this.offsets = { 0: 0 };
    this.bufsize = opts.bufsize || 4 * 1024;
    this.flags = opts.flags;
    this.mode = opts.mode;
}

inherits(FA, EventEmitter);

FA.prototype._read = function (start, end, cb) {
    var self = this;
    if (self.fd === undefined) {
        return self.once('open', self._read.bind(self, start, end, cb));
    }
    if (start === undefined) start = 0;
    if (start < 0) return self._readReverse(start, end, cb);
    
    var found = false;
    var line = null;
    
    var index = 0, offset = 0;
    for (var i = start; i > 0; i--) {
        if (self.offsets[i] !== undefined) {
            index = i;
            offset = self.offsets[i];
            break;
        }
    }
    
    if (index === start) line = [];
    
    var buffer = new Buffer(self.bufsize);
    
    (function _read () {
        fs.read(self.fd, buffer, 0, buffer.length, offset,
        function (err, bytesRead, buf) {
            if (err) return cb(err);
            if (bytesRead === 0) {
                if (line && line.length) cb(null, Buffer(line));
                return cb(null, null);
            }
            
            for (var i = 0; i < bytesRead; i++) {
                if (index >= start) line.push(buf[i]);
                
                if (buf[i] === 0x0a) {
                    self.offsets[++index] = offset + i + 1;
                    
                    if (index === start) {
                        line = [];
                    }
                    else if (index > start) {
                        cb(null, Buffer(line));
                        line = [];
                    }
                    
                    if (index === end) {
                        found = true;
                        line = null;
                        cb(null, null);
                        break;
                    }
                }
            }
            
            if (!found) {
                offset += bytesRead;
                _read();
            }
        });
    })();
};

FA.prototype._stat = function (cb) {
    var self = this;
    fs.stat(self.file, function (err, stat) {
        if (err) return cb && cb(err);
        
        self.stat = stat;
        self.emit('stat', stat);
        if (cb) cb(null, stat);
    });
};

FA.prototype._readReverse = function (start, end, cb) {
    var self = this;
    if (self.fd === undefined) {
        return self.once('open', function () {
            self._readReverse(start, end, cb);
        });
    }
    if (self.stat === undefined) {
        return self._stat(function (err) {
            if (err) cb(err);
            self._readReverse(start, end, cb)
        });
    }
    
    var found = false;
    
    if (end === 0) return nextTick(function () {
        cb(null, null);
    });
    if (end === undefined) end = 0;
    var index = 0, offset = self.stat.size;
    
    for (var i = end; i < 0; i++) {
        if (self.offsets[i] !== undefined) {
            index = i;
            offset = self.offsets[i];
            break;
        }
    }
    var buffer = new Buffer(self.bufsize);
    offset = Math.max(0, offset - buffer.length);
    
    var lines = null;
    if (index === end) lines = [];
    
    var firstNewline = true;
    (function _read () {
        fs.read(self.fd, buffer, 0, buffer.length, offset,
        function (err, bytesRead, buf) {
            if (err) return cb(err);
            if (bytesRead === 0) {
                lines.forEach(function (xs) {
                    cb(null, Buffer(xs));
                });
                return cb(null, null);
            }
            
            for (var i = bytesRead - 1; i >= 0; i--) {
                if (buf[i] === 0x0a) {
                    if (firstNewline && i + 1 < bytesRead && index === 0) {
                        lines.unshift(buf.slice(i+1, bytesRead));
                        self.offsets[--index] = offset + i - lines[0].length;
                    }
                    firstNewline = false;
                    self.offsets[--index] = offset + i;
                    
                    if (index === end) {
                        lines = [];
                    }
                    else if (index === start - 1) {
                        found = true;
                        lines.forEach(function (xs) {
                            cb(null, Buffer(xs));
                        });
                        cb(null, null);
                        lines = null;
                        break;
                    }
                    else if (index < end) {
                        lines.unshift([]);
                    }
                }
                
                if (index < end) {
                    if (!lines) lines = [];
                    if (!lines[0]) lines[0] = [];
                    lines[0].unshift(buf[i]);
                }
            }
            
            if (!found) {
                offset -= bytesRead;
                _read();
            }
        });
    })();
};

FA.prototype.slice = function (start, end, cb) {
    var res;
    if (typeof start === 'function') {
        cb = start;
        start = 0;
        end = undefined;
    }
    if (typeof end === 'function') {
        cb = end;
        end = undefined;
    }
    if (typeof cb === 'function') res = [];
    
    var tr = through();
    this._read(start, end, function (err, line) {
        if (err) return tr.emit('error', err);
        else tr.queue(line)
        
        if (cb && line === null) cb(null, res)
        else if (cb) res.push(line)
    });
    return tr;
};

FA.prototype.follow = function (start, end) {
    var self = this;
    var tr = through();
    tr.close = function () {
        this.closed = true;
        this.emit('close');
    };
    
    var slice = this.slice(start, end);
    var writing = false;
    var changed = false;
    
    slice.once('end', function () {
        if (tr.closed) return;
        var w = fs.watch(self.file, { fd: self.fd });
        tr.once('close', function () { w.close() });
        self.once('close', function () { w.close() });
        
        if (!self.stat) self._stat(onstat);
        else onstat(null, self.stat);
        
        w.on('change', function (type) {
            if (type !== 'change') return;
            if (!writing) self._stat(onstat);
            changed = true;
        });
        
    });
    var lastStat = null;
    slice.pipe(tr, { end: false });
    self.once('close', function () { tr.queue(null) });
    tr.once('close', function () { tr.queue(null) });
    
    return tr.pipe(split())
        .pipe(through(function (line) { this.queue(line + '\n') }))
    ;
    
    function onstat (err, stat) {
        if (err) return tr.emit('error', err);
        if (!lastStat) return lastStat = stat;
        
        if (stat.size < lastStat.size) {
            tr.emit('truncate', lastStat.size - stat.size);
        }
        else if (stat.size > lastStat.size) {
            writing = true;
            var stream = fs.createReadStream(self.file, {
                //fd: self.fd,
                start: lastStat.size,
                flags: self.flags,
                mode: self.mode,
                //autoClose: false,
                bufferSize: self.bufsize
            });
            stream.on('error', function (err) { tr.emit('error', err) });
            stream.on('end', function () {
                if (changed) self._stat(onstat);
                writing = false;
                changed = false;
            });
            stream.pipe(tr, { end: false });
        }
        
        lastStat = stat;
    }
};

FA.prototype.close = function () {
    var self = this;
    if (self.fd === undefined) return self.once('open', self.close);
    fs.close(self.fd, function () {
        self.emit('close');
    });
};
