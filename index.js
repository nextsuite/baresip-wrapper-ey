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
      'setAudioSource',
      'setAudioPlayer',
      'setAudioDevices',
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

        if (matches !== null && matches.length > 0) {
          this.callbacks[event](matches[matches.length - 1]);
        }
      });

      console.log(parsedData);
    });

    this.process.stderr.on('data', (data) => console.error(`${data}`));
  }

  /**
   * Cambia la fuente de audio (micrófono) de baresip.
   * Espera el formato completo "driver,device", por ejemplo:
   *   coreaudio,CSL-303455
   *   wasapi,Micrófono (Realtek...)
   *
   * Internamente ejecuta: ausrc &lt;target&gt;
   *
   * @param {string} target
   */
  setAudioSource(target) {
    if (!this.process || !this.process.stdin) {
      console.warn('[BARESIP WRAPPER] setAudioSource: process not running');
      return;
    }
    if (!target || typeof target !== 'string') {
      console.warn('[BARESIP WRAPPER] setAudioSource: invalid target');
      return;
    }
    console.log('[BARESIP WRAPPER] setAudioSource sending:', `ausrc ${target}`);
    this.process.stdin.write(`ausrc ${target}\n`);
  }

  /**
   * Cambia el reproductor de audio (salida) de baresip.
   * Espera el formato completo "driver,device", por ejemplo:
   *   coreaudio,Altavoces del Mac mini
   *   wasapi,Auriculares (Realtek...)
   *
   * Internamente ejecuta: auplay &lt;target&gt;
   *
   * @param {string} target
   */
  setAudioPlayer(target) {
    if (!this.process || !this.process.stdin) {
      console.warn('[BARESIP WRAPPER] setAudioPlayer: process not running');
      return;
    }
    if (!target || typeof target !== 'string') {
      console.warn('[BARESIP WRAPPER] setAudioPlayer: invalid target');
      return;
    }
    console.log('[BARESIP WRAPPER] setAudioPlayer sending:', `auplay ${target}`);
    this.process.stdin.write(`auplay ${target}\n`);
  }

  /**
   * Helper conveniente para cambiar fuente y salida en una sola llamada.
   * Espera un objeto del tipo:
   *   { source: 'driver,device', player: 'driver,device' }
   *
   * @param {{ source?: string, player?: string }} opts
   */
  setAudioDevices(opts) {
    if (!opts || typeof opts !== 'object') return;
    const { source, player } = opts;
    console.log('[BARESIP WRAPPER] setAudioDevices called with:', { source, player });
    if (source) this.setAudioSource(source);
    if (player) this.setAudioPlayer(player);
  }
}

module.exports = Baresip;
