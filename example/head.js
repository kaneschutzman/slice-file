var fileArray = require('../');
var s = fileArray('/usr/share/dict/words');

s.get(0, function (err, line) {
    console.log('line 0: ' + line.trim());
});

s.get(100, function (err, line) {
    console.log('line 100: ' + line.trim());
});

setTimeout(function () {
    s.slice(104, 108).pipe(process.stdout);
}, 100);