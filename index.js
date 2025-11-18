const { spawn } = require('child_process');
const { get } = require('http');
const { fixPath } = require('os-dependent-path-delimiter');
const kill = require('tree-kill');

const eventRegexps = {
    callEstablished: /Call established: (.+)/,
    callReceived: /Incoming call from:?[ \t]+([^ ]+)/i,
    hangUp: /(.+): session closed/,
    ready: /baresip is ready/,
    serverConnected: /\[\d+ bindings?\]/,
};

const options = { host: '127.0.0.1', port: '8000', agent: false };
const nop = () => {};

const executeCommand = (command) => {
    options.path = `/?${command}`;
    get(options, nop);
};

class Baresip {
    constructor(processPathOrOptions, callbacks = {}) {
        this.connected = false;
        this.callbacks = {};
        this.onHold = false;

        // Soportar API antigua (string) y nueva (objeto de opciones)
        if (typeof processPathOrOptions === 'string') {
            this.processPath = fixPath(processPathOrOptions);
            this.processArgs = [];
        } else {
            const opts = processPathOrOptions || {};

            // cmd / binary / processPath por orden de prioridad, con "baresip" como fallback
            this.processPath = fixPath(
                opts.cmd || opts.binary || opts.processPath || 'baresip',
            );

            this.processArgs = Array.isArray(opts.args) ? opts.args.slice() : [];

            // Si se pasa configDir, añadimos "-f <configDir>" al principio de los args
            if (opts.configDir) {
                this.processArgs.unshift(opts.configDir);
                this.processArgs.unshift('-f');
            }

            // Permitir callbacks dentro del objeto de opciones
            if (opts.callbacks && typeof opts.callbacks === 'object') {
                callbacks = opts.callbacks;
            }
        }

        Object.keys(eventRegexps).forEach((event) => {
            this.on(event, callbacks[event] === undefined ? () => {} : callbacks[event]);
        });

        [
            'on',
            'connect',
            'kill',
            'reload',
            'accept',
            'dial',
            'hangUp',
            'toggleCallMuted',
            'hold',
            'resume',
            'toggleHold',
        ].forEach((method) => {
            this[method] = this[method].bind(this);
        });
    }

    accept() {
        executeCommand('a');
    }
    

    dial(phoneNumber) {
        executeCommand(`d${phoneNumber}`);
    }

    hangUp() {
        executeCommand('b');
    }

    toggleCallMuted() {
        executeCommand('m');
    }

    // Poner la llamada en espera (HOLD) usando la CLI de baresip (stdio)
    hold() {
        if (!this.process || !this.process.stdin) {
            console.warn('[BARESIP WRAPPER] hold: process not running');
            return;
        }

        // 'x' = HOLD CALL en la interfaz stdio de baresip
        this.process.stdin.write('x\n');
        this.onHold = true;
    }

    // Quitar la espera (RESUME)
    resume() {
        if (!this.process || !this.process.stdin) {
            console.warn('[BARESIP WRAPPER] resume: process not running');
            return;
        }

        // 'X' = RESUME CALL en la interfaz stdio de baresip
        this.process.stdin.write('X\n');
        this.onHold = false;
    }

    // Alternar entre hold y resume de forma cómoda desde la UI
    toggleHold() {
        if (this.onHold) {
            this.resume();
        } else {
            this.hold();
        }
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    kill(callback) {
        if (!this.process || !this.process.pid) {
            if (callback !== undefined) {
                callback();
            }
            return;
        }

        kill(this.process.pid, 'SIGKILL', (err) => {
            if (!err) {
                this.connected = false;

                if (callback !== undefined) {
                    callback();
                }
            }
        });
    }

    reload() {
        this.kill(() => this.connect());
    }

    connect() {
        this.connected = true;
        this.process = spawn(this.processPath, this.processArgs || []);

        this.process.stdout.on('data', (data) => {
            const parsedData = `${data}`;

            Object.keys(eventRegexps).forEach((event) => {
                const matches = parsedData.match(eventRegexps[event]);

                if ((matches !== null) && (matches.length > 0)) {
                    this.callbacks[event](matches[matches.length - 1]);
                }
            });

            console.log(parsedData);
        });

        this.process.stderr.on('data', (data) => console.error(`${data}`));
    }
}

module.exports = Baresip;
