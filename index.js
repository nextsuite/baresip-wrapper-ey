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
    this._cliCommand = null;

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
      'listAudioDevices',
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

      // Si hay un comando CLI pendiente (_cliCommand), acumulamos la salida
      if (this._cliCommand) {
        this._cliCommand.buffer += parsedData;
      }

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
   * Ejecuta un comando en la CLI de baresip (vía stdin) y recoge la salida
   * durante un tiempo corto. Esto se usa para listar dispositivos de audio (ausrc/auplay).
   *
   * @param {string} command
   * @param {number} timeoutMs
   * @returns {Promise<string>}
   */
  _runCliCommand(command, timeoutMs = 400) {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error('[BARESIP WRAPPER] process not running'));
    }

    if (this._cliCommand) {
      return Promise.reject(
        new Error('[BARESIP WRAPPER] another CLI command is in progress'),
      );
    }

    return new Promise((resolve, reject) => {
      this._cliCommand = { buffer: '' };
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        const output = this._cliCommand ? this._cliCommand.buffer : '';
        this._cliCommand = null;
        resolve(output);
      };

      const timer = setTimeout(finish, timeoutMs);

      try {
        this.process.stdin.write(`${command}\n`, (err) => {
          if (err) {
            clearTimeout(timer);
            if (!finished) {
              finished = true;
              this._cliCommand = null;
              reject(err);
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        if (!finished) {
          finished = true;
          this._cliCommand = null;
          reject(err);
        }
      }
    });
  }

  /**
   * Intenta extraer una lista de nombres de dispositivo a partir de la salida
   * de los comandos ausrc/auplay. Es un parser genérico que se puede afinar
   * más adelante según el formato real.
   *
   * @param {string} output
   * @returns {string[]}
   */
  _parseAudioList(output) {
    if (!output) return [];

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        const lower = line.toLowerCase();
        // Filtramos prompts y líneas claramente no relevantes
        if (lower.startsWith('&gt;') || lower.startsWith('>')) return false;
        if (lower.includes('usage')) return false;
        return true;
      });
  }

  /**
   * Devuelve la lista de dispositivos de entrada y salida que baresip ve
   * usando los comandos "ausrc" (entradas) y "auplay" (salidas).
   *
   * @returns {Promise<{inputs: string[], outputs: string[]}>}
   */
  async listAudioDevices() {
    if (!this.process || !this.process.stdin) {
      throw new Error('[BARESIP WRAPPER] process not running');
    }

    const ausrcOutput = await this._runCliCommand('ausrc');
    const auplayOutput = await this._runCliCommand('auplay');

    const inputs = this._parseAudioList(ausrcOutput);
    const outputs = this._parseAudioList(auplayOutput);

    return { inputs, outputs };
  }
}

module.exports = Baresip;
