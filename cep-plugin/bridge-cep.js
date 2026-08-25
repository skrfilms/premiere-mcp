/**
 * MCP Premiere Pro Bridge (CEP)
 * Uses CSInterface.evalScript to run ExtendScript in Premiere Pro.
 * Works in release Premiere Pro — no Beta or UXP Developer Tool required.
 */

(function() {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var EXTENDSCRIPT_COMPAT_HELPERS = [
        '// Built from character codes rather than backslash literals: this text is',
        '// assembled in JavaScript before it reaches the host, so an escape written',
        '// for the ExtendScript string would be consumed once on the way.',
        'function __mcpEscapeString(value) {',
        '    var text = String(value);',
        '    var backslash = String.fromCharCode(92);',
        '    var out = "";',
        '    for (var i = 0; i < text.length; i++) {',
        '        var code = text.charCodeAt(i);',
        '        if (code === 34) { out += backslash + String.fromCharCode(34); }',
        '        else if (code === 92) { out += backslash + backslash; }',
        '        else if (code === 8) { out += backslash + "b"; }',
        '        else if (code === 9) { out += backslash + "t"; }',
        '        else if (code === 10) { out += backslash + "n"; }',
        '        else if (code === 12) { out += backslash + "f"; }',
        '        else if (code === 13) { out += backslash + "r"; }',
        '        else if (code < 32 || code === 0x2028 || code === 0x2029) {',
        '            var hex = code.toString(16);',
        '            while (hex.length < 4) { hex = "0" + hex; }',
        '            out += backslash + "u" + hex;',
        '        }',
        '        else { out += text.charAt(i); }',
        '    }',
        '    return out;',
        '}',
        '// Saved before anything can shadow it: reading hasOwnProperty off the value',
        '// being serialised lets that value decide which of its keys are emitted.',
        'var __mcpOwnProperty = Object.prototype.hasOwnProperty;',
        'function __mcpStringify(value) {',
        '    if (value === null) return "null";',
        '    var valueType = typeof value;',
        '    if (valueType === "string") return "\\"" + __mcpEscapeString(value) + "\\"";',
        '    if (valueType === "number") return isFinite(value) ? String(value) : "null";',
        '    if (valueType === "boolean") return value ? "true" : "false";',
        '    if (value instanceof Array) {',
        '        var arrayParts = [];',
        '        for (var i = 0; i < value.length; i++) {',
        '            arrayParts.push(__mcpStringify(value[i]));',
        '        }',
        '        return "[" + arrayParts.join(",") + "]";',
        '    }',
        '    if (valueType === "object") {',
        '        var objectParts = [];',
        '        for (var key in value) {',
        '            var isOwn = true;',
        '            try { isOwn = __mcpOwnProperty.call(value, key); } catch (ownError) { isOwn = true; }',
        '            if (!isOwn) continue;',
        '            var member;',
        '            try { member = value[key]; } catch (readError) { continue; }',
        '            if (typeof member === "undefined" || typeof member === "function") continue;',
        '            objectParts.push(__mcpStringify(String(key)) + ":" + __mcpStringify(member));',
        '        }',
        '        return "{" + objectParts.join(",") + "}";',
        '    }',
        '    return "null";',
        '}',
        'if (typeof JSON === "undefined") { JSON = {}; }',
        '// Installed unconditionally, matching the server prelude. This engine has',
        '// no JSON of its own, so the previous escaper was always the live one and',
        '// it passed control characters through raw. See src/bridge/index.ts.',
        'JSON.stringify = __mcpStringify;',
        'function __mcpParse(text) {',
        '  var source = String(text);',
        '  var at = 0;',
        '',
        '  function fail(what) {',
        '    throw new Error("JSON.parse: " + what + " at position " + at);',
        '  }',
        '  function skipWhitespace() {',
        '    while (at < source.length) {',
        '      var code = source.charCodeAt(at);',
        '      if (code === 32 || code === 9 || code === 10 || code === 13) { at++; } else { break; }',
        '    }',
        '  }',
        '  function expect(code) {',
        '    if (source.charCodeAt(at) !== code) fail("expected character " + code);',
        '    at++;',
        '  }',
        '  function parseString() {',
        '    expect(34);',
        '    var out = "";',
        '    while (at < source.length) {',
        '      var code = source.charCodeAt(at);',
        '      if (code === 34) { at++; return out; }',
        '      if (code === 92) {',
        '        at++;',
        '        var esc = source.charCodeAt(at);',
        '        at++;',
        '        if (esc === 34) { out += String.fromCharCode(34); }',
        '        else if (esc === 92) { out += String.fromCharCode(92); }',
        '        else if (esc === 47) { out += "/"; }',
        '        else if (esc === 98) { out += String.fromCharCode(8); }',
        '        else if (esc === 102) { out += String.fromCharCode(12); }',
        '        else if (esc === 110) { out += String.fromCharCode(10); }',
        '        else if (esc === 114) { out += String.fromCharCode(13); }',
        '        else if (esc === 116) { out += String.fromCharCode(9); }',
        '        else if (esc === 117) {',
        '          var hex = source.substr(at, 4);',
        '          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad unicode escape");',
        '          out += String.fromCharCode(parseInt(hex, 16));',
        '          at += 4;',
        '        }',
        '        else fail("bad escape");',
        '        continue;',
        '      }',
        '      // Unescaped control characters are not legal inside a JSON string.',
        '      if (code < 32) fail("unescaped control character");',
        '      out += source.charAt(at);',
        '      at++;',
        '    }',
        '    fail("unterminated string");',
        '  }',
        '  function parseNumber() {',
        '    var start = at;',
        '    if (source.charCodeAt(at) === 45) at++;',
        '    while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;',
        '    if (source.charCodeAt(at) === 46) {',
        '      at++;',
        '      while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;',
        '    }',
        '    var exponent = source.charCodeAt(at);',
        '    if (exponent === 101 || exponent === 69) {',
        '      at++;',
        '      var sign = source.charCodeAt(at);',
        '      if (sign === 43 || sign === 45) at++;',
        '      while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;',
        '    }',
        '    var literal = source.substring(start, at);',
        '    if (!/^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(literal)) fail("bad number");',
        '    return Number(literal);',
        '  }',
        '  function parseWord() {',
        '    if (source.substr(at, 4) === "true") { at += 4; return true; }',
        '    if (source.substr(at, 5) === "false") { at += 5; return false; }',
        '    if (source.substr(at, 4) === "null") { at += 4; return null; }',
        '    fail("unexpected token");',
        '  }',
        '  function parseValue() {',
        '    skipWhitespace();',
        '    var code = source.charCodeAt(at);',
        '    if (code === 34) return parseString();',
        '    if (code === 123) {',
        '      at++;',
        '      var object = {};',
        '      skipWhitespace();',
        '      if (source.charCodeAt(at) === 125) { at++; return object; }',
        '      for (;;) {',
        '        skipWhitespace();',
        '        var key = parseString();',
        '        skipWhitespace();',
        '        expect(58);',
        '        var member = parseValue();',
        '        if (key === "__proto__") {',
        '          // Plain assignment here replaces the object"s prototype instead of',
        '          // adding a key: the value is then unreachable as an own property and',
        '          // the object inherits from whatever the payload contained. Define it',
        '          // where the engine allows, and otherwise drop it -- losing one key is',
        '          // recoverable, silently reparenting the object is not.',
        '          if (typeof Object.defineProperty === "function") {',
        '            try {',
        '              Object.defineProperty(object, key, {',
        '                value: member, enumerable: true, writable: true, configurable: true',
        '              });',
        '            } catch (defineError) { /* left out rather than assigned */ }',
        '          }',
        '        } else {',
        '          object[key] = member;',
        '        }',
        '        skipWhitespace();',
        '        if (source.charCodeAt(at) === 44) { at++; continue; }',
        '        expect(125);',
        '        return object;',
        '      }',
        '    }',
        '    if (code === 91) {',
        '      at++;',
        '      var array = [];',
        '      skipWhitespace();',
        '      if (source.charCodeAt(at) === 93) { at++; return array; }',
        '      for (;;) {',
        '        array.push(parseValue());',
        '        skipWhitespace();',
        '        if (source.charCodeAt(at) === 44) { at++; continue; }',
        '        expect(93);',
        '        return array;',
        '      }',
        '    }',
        '    if (code === 45 || (code >= 48 && code <= 57)) return parseNumber();',
        '    return parseWord();',
        '  }',
        '',
        '  var result = parseValue();',
        '  skipWhitespace();',
        '  if (at < source.length) fail("unexpected trailing content");',
        '  return result;',
        '}',
        'JSON.parse = __mcpParse;'
    ].join('\n');

    function getDefaultTempPath() {
        if (process.env.PREMIERE_TEMP_DIR) {
            return sanitizeTempDirectoryInput(process.env.PREMIERE_TEMP_DIR);
        }
        var base = (os.platform() === 'win32') ? (process.env.TEMP || process.env.TMP || 'C:\\Temp') : '/tmp';
        return path.join(base, 'premiere-mcp-bridge');
    }

    function getPanelConfigPath() {
        var configDir = path.join(os.homedir(), '.premiere-mcp-bridge');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        return path.join(configDir, 'config.json');
    }

    function ensureDirectory(dirPath) {
        if (!dirPath) return null;
        var resolvedPath = path.resolve(dirPath);
        if (!fs.existsSync(resolvedPath)) {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }
        if (!fs.statSync(resolvedPath).isDirectory()) {
            throw new Error('Temp path is not a directory: ' + resolvedPath);
        }
        return resolvedPath;
    }

    function sanitizeTempDirectoryInput(value) {
        if (!value || typeof value !== 'string') return '';
        var trimmed = value.trim();

        function normalizePathLiteral(pathValue) {
            return pathValue.trim().replace(/\\\\/g, '\\');
        }

        try {
            if (trimmed.charAt(0) === '{') {
                var parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed.PREMIERE_TEMP_DIR === 'string') {
                    return normalizePathLiteral(parsed.PREMIERE_TEMP_DIR);
                }
                if (parsed && typeof parsed.tempDirectory === 'string') {
                    return normalizePathLiteral(parsed.tempDirectory);
                }
            }
        } catch (e) {}

        var envMatch = trimmed.match(/["']?PREMIERE_TEMP_DIR["']?\s*:\s*["']([^"']+)["']/);
        if (envMatch && envMatch[1]) {
            trimmed = normalizePathLiteral(envMatch[1]);
        } else {
            trimmed = normalizePathLiteral(trimmed.replace(/^["']|["']$/g, ''));
        }

        if (os.platform() === 'win32' && /^\/tmp(?:\/|$)/.test(trimmed)) {
            return '';
        }

        return trimmed;
    }

    function MCPPremiereBridge() {
        this.isConnected = false;
        this.tempDirectory = '';
        this.commandQueue = [];
        this.isProcessing = false;
        // Which command the panel is executing right now, and when it started, so the
        // server-side heartbeat reader can distinguish "busy on a long op" from "wedged
        // behind a modal dialog" from "crashed" — all of which used to look identical.
        this.currentCommandId = null;
        this.currentCommandStartedAt = null;
        // Loopback WebSocket transport. `socket` is non-null from the moment a dial starts, so one
        // attempt is in flight at a time; `socketReady` turns true only after the server's welcome,
        // so nothing is pushed to a connection that has not been authenticated and version-checked.
        this.socket = null;
        this.socketReady = false;
        this.socketEndpoint = null;
        this.socketNextAttemptAt = 0;
        this.socketUnavailableLogged = false;
        this.csInterface = new CSInterface();
        this.init();
    }

    MCPPremiereBridge.prototype.normalizeHostEnvironment = function(hostEnv) {
        if (!hostEnv) return null;
        if (typeof hostEnv === 'string') {
            return JSON.parse(hostEnv);
        }
        return hostEnv;
    };

    MCPPremiereBridge.prototype.init = function() {
        this.log('Initializing MCP Bridge (CEP)...', 'info');

        // Check host environment
        try {
            var env = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            if (env) {
                this.log('Premiere Pro version: ' + env.appVersion + ' (build ' + env.appId + ')', 'info');
            }
        } catch (e) {
            this.log('Warning: Could not get host environment: ' + e.message, 'warning');
        }

        this.loadConfig();
        this.updateUI();
        this.startCommandPolling();

        // Auto-connect on panel open. Previously the panel came up polling but
        // disconnected, so every Premiere launch needed a human to click Start Bridge
        // before any tool call could succeed — and a tool call against a not-started
        // panel fails as a timeout, which reads like a broken server rather than an
        // unclicked button. Runs after loadConfig() so it uses the configured temp
        // directory, and is guarded so a failure here still leaves a usable panel with
        // a working manual button. Opt out by setting mcpAutoStart=false in localStorage.
        var autoStart = true;
        try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem('mcpAutoStart') === 'false') {
                autoStart = false;
            }
        } catch (storageError) { /* localStorage unavailable: keep the default */ }

        if (autoStart) {
            var self = this;
            setTimeout(function() {
                try {
                    if (!self.isConnected) {
                        self.log('Auto-starting bridge on panel open...', 'info');
                        self.startBridge();
                    }
                } catch (e) {
                    self.log('Auto-start failed, use Start Bridge manually: ' + e.message, 'warning');
                }
            }, 500);
        }
    };

    MCPPremiereBridge.prototype.getTempDirectory = function() {
        var targetPath = this.tempDirectory || getDefaultTempPath();
        try {
            this.tempDirectory = ensureDirectory(targetPath);
            return this.tempDirectory;
        } catch (e) {
            this.log('Error creating temp directory: ' + e.message, 'error');
            return null;
        }
    };

    MCPPremiereBridge.prototype.getDiagnosticReportPath = function() {
        var tempDir = this.getTempDirectory();
        if (!tempDir) return null;
        return path.join(tempDir, 'premiere-mcp-diagnostics-latest.json');
    };

    MCPPremiereBridge.prototype.writeDiagnosticReport = function(report) {
        try {
            var reportPath = this.getDiagnosticReportPath();
            if (!reportPath) return null;
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            return reportPath;
        } catch (e) {
            this.log('Failed to write diagnostics report: ' + e.message, 'error');
            return null;
        }
    };

    MCPPremiereBridge.prototype.watchDirectory = function(dirPath) {
        try {
            var watchedPath = ensureDirectory(dirPath);
            var files = fs.readdirSync(watchedPath);
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                if (file.indexOf('command-') === 0 && file.indexOf('.json') === file.length - 5) {
                    this.processCommandFile(path.join(watchedPath, file));
                    return;
                }
            }
        } catch (e) {
            this.log('Error watching directory: ' + e.message, 'error');
        }
    };

    // The server polls for this exact filename, so writing it directly publishes the
    // name before the content is complete and the server can read a truncated response.
    // rename() within one directory is atomic, so the file appears only once whole.
    MCPPremiereBridge.prototype.writeResponseAtomic = function(responseFile, payload) {
        var staging = responseFile + '.part';
        fs.writeFileSync(staging, JSON.stringify(payload, null, 2));
        fs.renameSync(staging, responseFile);
    };

    /**
     * Read the per-session auth token the server writes to auth-token.json.
     *
     * Re-read on every check rather than cached: the server rewrites the file each session, and a
     * cached token would make the panel reject every command from a server that restarted while the
     * panel stayed open — which is the normal case, since the MCP server is launched per session
     * over stdio and Premiere outlives it.
     */
    MCPPremiereBridge.prototype.readExpectedToken = function() {
        try {
            var tokenPath = path.join(this.tempDirectory, 'auth-token.json');
            if (!fs.existsSync(tokenPath)) return null;
            var parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            return (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) ? parsed.token : null;
        } catch (e) {
            return null;
        }
    };

    /**
     * Decide whether to run a command.
     *
     * Enforced ONLY when auth-token.json exists. That is the backwards-compatible half: an older
     * server that never writes a token keeps working, while any current server always writes one, so
     * enforcement is on in practice. Rejection is by comparing the whole string — this is a local
     * file-permission boundary, not a network one, so timing-attack hardening would be theatre
     * against an attacker who can simply read the file.
     */
    MCPPremiereBridge.prototype.isCommandAuthorized = function(command) {
        var expected = this.readExpectedToken();
        if (!expected) return { ok: true, reason: 'no token file present; running unauthenticated (older server)' };
        var supplied = command && typeof command.token === 'string' ? command.token : '';
        if (supplied.length !== expected.length) return { ok: false, reason: supplied ? 'token length mismatch' : 'command carried no token' };
        var same = true;
        for (var i = 0; i < expected.length; i++) { if (supplied.charAt(i) !== expected.charAt(i)) same = false; }
        return same ? { ok: true } : { ok: false, reason: 'token did not match this session' };
    };

    MCPPremiereBridge.prototype.processCommandFile = function(filePath) {
        var self = this;
        try {
            var fileContent = fs.readFileSync(filePath, 'utf8');
            var command = JSON.parse(fileContent);

            // AUTHORISE BEFORE EXECUTING. Anything that can write into this directory could
            // previously run arbitrary ExtendScript inside Premiere, with full project access and
            // filesystem reach through the cep_js path. A rejected command is answered (so a
            // legitimate-but-misconfigured caller learns why instead of waiting for a timeout) and
            // deleted, but never run.
            var authResult = this.isCommandAuthorized(command);
            if (!authResult.ok) {
                this.log('REJECTED command ' + command.id + ': ' + authResult.reason, 'error');
                try {
                    this.writeResponseAtomic(filePath.replace('command-', 'response-'), {
                        success: false,
                        error: 'Command rejected by the Premiere bridge panel: ' + authResult.reason +
                               '. The panel requires the per-session token from auth-token.json in the shared temp directory.',
                        code: 'UNAUTHORIZED',
                        timestamp: new Date().toISOString()
                    });
                } catch (eAuthWrite) {}
                try { fs.unlinkSync(filePath); } catch (eAuthUnlink) {}
                return;
            }

            this.log('Processing command: ' + command.id, 'info');
            this.addToQueue(command);
            this.isProcessing = true;
            this.currentCommandId = command.id;
            this.currentCommandStartedAt = Date.now();
            this.executeCommand(command, function(result) {
                var responseFile = filePath.replace('command-', 'response-');
                var responsePublished = false;
                try {
                    self.writeResponseAtomic(responseFile, result);
                    responsePublished = true;

                    // Guarded on its own. The server removes the command file on its
                    // timeout path, so this unlink can legitimately fail — and if it were
                    // allowed to reach the catch below it would overwrite the result that
                    // was just published, turning a completed command into an error.
                    try { fs.unlinkSync(filePath); } catch (eUnlink) {}

                    self.log('Command completed: ' + command.id, 'info');
                    self.updateCommandStatus(command.id, 'completed');
                } catch (e) {
                    if (!responsePublished) {
                        try {
                            self.writeResponseAtomic(responseFile, { error: e.message, timestamp: new Date().toISOString() });
                        } catch (eWrite) {}
                    }
                }
                self.isProcessing = false;
                self.currentCommandId = null;
                self.currentCommandStartedAt = null;
            });
        } catch (e) {
            this.log('Error processing command file: ' + e.message, 'error');
            try {
                var responseFile = filePath.replace('command-', 'response-');
                this.writeResponseAtomic(responseFile, { error: e.message, timestamp: new Date().toISOString() });
                try { fs.unlinkSync(filePath); } catch (eUnlink) {}
            } catch (e2) {}
            this.isProcessing = false;
            this.currentCommandId = null;
            this.currentCommandStartedAt = null;
        }
    };

    MCPPremiereBridge.prototype.executeCommand = function(command, done) {
        var self = this;
        this.updateCommandStatus(command.id, 'executing');

        // CEP JavaScript execution — runs in the panel JS context, not ExtendScript.
        // Exposes window.cep, csInterface, and all browser-level APIs.
        if (command.type === 'cep_js') {
            try {
                var csInterface = this.csInterface;
                var bridge = this;
                var cepResult = (new Function('csInterface', 'window', 'bridge', command.script))(csInterface, window, bridge);
                // If a Promise, wait for it; otherwise wrap synchronous result
                if (cepResult && typeof cepResult.then === 'function') {
                    cepResult.then(function(val) {
                        done({ success: true, result: val, timestamp: new Date().toISOString() });
                    }).catch(function(err) {
                        done({ success: false, error: String(err && err.message ? err.message : err) });
                    });
                } else {
                    done({ success: true, result: cepResult !== undefined ? cepResult : null, timestamp: new Date().toISOString() });
                }
            } catch(e) {
                done({ success: false, error: e.message || String(e) });
            }
            return;
        }

        if (!this.validateScript(command.script)) {
            done({ success: false, error: 'Script validation failed' });
            return;
        }
        this.executeExtendScript(command.script, function(err, result) {
            if (err) {
                done({ success: false, error: err.message });
                return;
            }
            done({ success: true, result: result, timestamp: new Date().toISOString() });
        }, command.timeoutMs);
    };

    MCPPremiereBridge.prototype.executeExtendScript = function(script, callback, requestedTimeoutMs) {
        var self = this;
        try {
            if (!this.csInterface) {
                callback(new Error('CSInterface not initialized'));
                return;
            }

            // Get host environment info for debugging
            var hostEnv = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            if (!hostEnv) {
                callback(new Error('Could not get host environment. Is Premiere Pro running?'));
                return;
            }

            var fullScript = EXTENDSCRIPT_COMPAT_HELPERS + '\n' + script;
            var settled = false;
            // Honor a per-command timeout from the server (batch operations request up to 300s).
            // Fall back to 45s when the server does not specify one, and never go below it.
            var timeoutMs = 45000;
            if (typeof requestedTimeoutMs === 'number' && requestedTimeoutMs > timeoutMs) {
                timeoutMs = requestedTimeoutMs;
            }
            var timeoutId = setTimeout(function() {
                if (settled) return;
                settled = true;
                callback(new Error(
                    'ExtendScript execution timed out after ' + timeoutMs + 'ms. ' +
                    'Premiere Pro or the CEP scripting host did not return a result.'
                ));
            }, timeoutMs);

            this.csInterface.evalScript(fullScript, function(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                self.log('EvalScript result: ' + result, 'info');

                if (result === 'EvalScript error.' || result === 'EvalScript error') {
                    callback(new Error(
                        'ExtendScript execution failed via CEP evalScript(). ' +
                        'This is usually a host-side scripting failure or CEP compatibility issue, not a JSON parsing problem.'
                    ));
                    return;
                }

                if (typeof result === 'string' && result.indexOf('Error') === 0) {
                    callback(new Error(result));
                    return;
                }

                try {
                    var parsed = JSON.parse(result);
                    callback(null, parsed);
                } catch (e) {
                    callback(null, result);
                }
            });
        } catch (e) {
            callback(e);
        }
    };

    MCPPremiereBridge.prototype.validateScript = function(script) {
        if (!script || typeof script !== 'string') return false;
        var dangerous = [
            /eval\s*\(/i,
            /\bnew\s+Function\s*\(/i,
            /\brequire\s*\(/i,
            /\b__dirname\b/i,
            /\b__filename\b/i,
            /\bprocess\./i,
            /\bchild_process\b/i
        ];
        for (var i = 0; i < dangerous.length; i++) {
            if (dangerous[i].test(script)) return false;
        }
        return script.length <= 500000;
    };

    // Liveness beacon written into the shared temp directory on every poll tick. The
    // server reads it to fail fast (and with a specific reason) instead of blocking a
    // caller for the whole timeout when the panel is not started, is wedged behind a
    // modal dialog, or has crashed. Written atomically via rename so the server never
    // reads a torn beacon, and wrapped so a heartbeat failure can never disturb the panel.
    MCPPremiereBridge.prototype.writeHeartbeat = function() {
        try {
            var tempPath = this.getTempDirectory();
            if (!tempPath) return;
            var payload = {
                ts: Date.now(),
                connected: this.isConnected === true,
                isProcessing: this.isProcessing === true,
                currentCommandId: this.currentCommandId || null,
                currentCommandStartedAt: this.currentCommandStartedAt || null,
                queueLength: this.commandQueue ? this.commandQueue.length : 0
            };
            var hbFile = path.join(tempPath, 'bridge-heartbeat.json');
            var staging = hbFile + '.part';
            fs.writeFileSync(staging, JSON.stringify(payload));
            fs.renameSync(staging, hbFile);
        } catch (e) {
            // A heartbeat that cannot be written is not worth surfacing or retrying; the
            // server degrades to its original full-timeout behaviour when it sees none.
        }
    };

    // ── Loopback WebSocket transport ───────────────────────────────────────────────────
    //
    // The file poll below is a ~250ms tick, so every command paid up to that before Premiere had
    // done any work at all. The server now also listens on 127.0.0.1 on an ephemeral port and
    // publishes it in bridge-endpoint.json; this half dials in, authenticates, announces what it can
    // do, and then runs commands through THE SAME executeCommand path the file poller uses. One
    // execution path, two ways of being asked.
    //
    // The browser WebSocket is used, not a Node one. CEF gives the panel a real WebSocket global and
    // the panel is not allowed to require() anything beyond fs/path/os, so there is nothing to
    // install on this side. Where the global is missing (an older CEF, or a test harness) the panel
    // simply stays on the file poll and says so once.
    //
    // EXACTLY ONE CHANNEL PER COMMAND. The server publishes to the socket or to a file, never both.
    // This half enforces the same rule from the other end: while the socket is handshaken, the file
    // scan is skipped entirely, so even a stale command file cannot be executed alongside a socket
    // command.
    var SOCKET_PROTOCOL_VERSION = '1.0';
    // Reconnect on close only, never on error — an error is followed by a close, and reconnecting on
    // both produces a storm against a listener that is refusing connections.
    var SOCKET_RECONNECT_MS = 2000;

    MCPPremiereBridge.prototype.readBridgeEndpoint = function() {
        try {
            if (!this.tempDirectory) return null;
            var endpointPath = path.join(this.tempDirectory, 'bridge-endpoint.json');
            if (!fs.existsSync(endpointPath)) return null;
            var parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
            if (!parsed || typeof parsed.port !== 'number' || parsed.port <= 0) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    };

    // Called from the poll tick, so a server that starts after Premiere is picked up without any
    // separate timer. Guarded so one dial is in flight at a time and a refused port backs off.
    MCPPremiereBridge.prototype.maintainSocket = function() {
        if (this.socket) return;
        if (typeof WebSocket === 'undefined') {
            if (!this.socketUnavailableLogged) {
                this.socketUnavailableLogged = true;
                this.log('No WebSocket in this runtime; staying on the file transport.', 'warning');
            }
            return;
        }
        if (this.socketNextAttemptAt && Date.now() < this.socketNextAttemptAt) return;
        this.socketNextAttemptAt = Date.now() + SOCKET_RECONNECT_MS;
        this.connectSocket();
    };

    MCPPremiereBridge.prototype.connectSocket = function() {
        var self = this;
        var endpoint = this.readBridgeEndpoint();
        if (!endpoint) return;
        // Re-read every attempt rather than cached: the MCP server is launched per session over
        // stdio and Premiere outlives it, so the port changes underneath a long-lived panel.
        this.socketEndpoint = endpoint;
        var url = 'ws://127.0.0.1:' + endpoint.port;
        var socket;
        try {
            socket = new WebSocket(url);
        } catch (e) {
            this.log('Could not open the bridge socket: ' + e.message, 'warning');
            return;
        }
        this.socket = socket;
        this.socketReady = false;

        socket.onopen = function() {
            var premiereVersion = null;
            try {
                var env = self.normalizeHostEnvironment(self.csInterface.getHostEnvironment());
                if (env && env.appVersion) premiereVersion = String(env.appVersion);
            } catch (eEnv) {}
            // The hello is the first frame and carries the token, so the server never has to hold an
            // unauthenticated connection open waiting for a second frame. The feature list is what
            // the server gates behaviour on: anything absent from it is sent over the file channel
            // instead of being attempted and failing.
            self.sendSocketFrame({
                type: 'hello',
                token: self.readExpectedToken(),
                protocolVersion: SOCKET_PROTOCOL_VERSION,
                features: ['extendscript', 'cep_js', 'heartbeat'],
                premiereVersion: premiereVersion,
                engine: 'extendscript'
            });
        };

        socket.onmessage = function(event) {
            self.handleSocketMessage(event && event.data);
        };

        socket.onerror = function() {
            // Logged only. The close handler below owns cleanup and reconnect scheduling; doing it
            // here as well produced two reconnects per failure.
            self.log('Bridge socket error (a close will follow).', 'warning');
        };

        socket.onclose = function(event) {
            var code = event && event.code ? event.code : 0;
            var reason = event && event.reason ? event.reason : '';
            self.socket = null;
            self.socketReady = false;
            self.socketNextAttemptAt = Date.now() + SOCKET_RECONNECT_MS;
            // 4002/4003 are configuration faults, not transient ones: reconnecting on a 2s loop
            // would spam the log with the same refusal forever, so say it once and plainly.
            if (code === 4002) {
                self.log('Bridge socket rejected: the token did not match this session. The panel ' +
                    'is reading auth-token.json from ' + self.tempDirectory + ' — check that it is ' +
                    'the same directory the MCP server uses. Falling back to the file transport.', 'error');
            } else if (code === 4003) {
                self.log('Bridge socket rejected: protocol version mismatch. ' + reason +
                    ' Reinstall the CEP panel so it ships from the same build as the server. ' +
                    'Falling back to the file transport.', 'error');
            } else if (code === 4001) {
                self.log('Bridge socket closed: the server saw no hello in time. Falling back to ' +
                    'the file transport and retrying.', 'warning');
            } else {
                self.log('Bridge socket closed (' + code + '). Falling back to the file transport ' +
                    'and retrying.', 'info');
            }
        };
    };

    MCPPremiereBridge.prototype.disconnectSocket = function() {
        if (!this.socket) return;
        var socket = this.socket;
        this.socket = null;
        this.socketReady = false;
        try { socket.close(1000, 'panel stopped'); } catch (e) {}
    };

    MCPPremiereBridge.prototype.sendSocketFrame = function(frame) {
        if (!this.socket) return false;
        try {
            this.socket.send(JSON.stringify(frame));
            return true;
        } catch (e) {
            this.log('Could not send a bridge frame: ' + e.message, 'warning');
            return false;
        }
    };

    MCPPremiereBridge.prototype.handleSocketMessage = function(data) {
        var frame;
        try {
            frame = JSON.parse(String(data));
        } catch (e) {
            this.log('Ignoring unparseable bridge frame.', 'warning');
            return;
        }
        if (!frame || typeof frame !== 'object') return;

        if (frame.type === 'welcome') {
            this.socketReady = true;
            this.log('Bridge socket ready: server protocol ' + frame.protocolVersion +
                ', session ' + frame.sessionId + '. Commands now arrive by push; the file poll ' +
                'stays as the fallback.', 'info');
            return;
        }
        if (frame.type === 'error') {
            this.log('Bridge server error frame (' + frame.code + '): ' + frame.message, 'error');
            return;
        }
        if (frame.type === 'command') {
            this.executeSocketCommand(frame);
            return;
        }
        this.log('Ignoring bridge frame of unknown type: ' + String(frame.type), 'warning');
    };

    MCPPremiereBridge.prototype.executeSocketCommand = function(frame) {
        var self = this;
        var command = {
            id: frame.id,
            type: (frame.commandType === 'cep_js') ? 'cep_js' : 'extendscript',
            script: frame.script,
            timeoutMs: (typeof frame.timeoutMs === 'number') ? frame.timeoutMs : undefined,
            token: frame.token
        };

        // The same authorisation check the file path runs, against the same token file. The socket
        // was already authenticated at handshake, so on a healthy connection this can only pass —
        // which is the point: one check covers both channels, so auth cannot be tightened on one and
        // silently left off the other.
        var authResult = this.isCommandAuthorized(command);
        if (!authResult.ok) {
            this.log('REJECTED socket command ' + command.id + ': ' + authResult.reason, 'error');
            this.sendSocketFrame({
                type: 'response',
                id: command.id,
                ok: false,
                error: 'Command rejected by the Premiere bridge panel: ' + authResult.reason +
                       '. The panel requires the per-session token from auth-token.json in the shared temp directory.'
            });
            return;
        }

        // The in-flight guard is shared with the file path on purpose. An outstanding evalScript
        // cannot be cancelled, so a second concurrent command would have its completion callback
        // clear isProcessing out from under the first.
        if (this.isProcessing && this.currentCommandId && this.currentCommandId !== command.id) {
            this.sendSocketFrame({
                type: 'response',
                id: command.id,
                ok: false,
                error: 'The panel is already executing command ' + this.currentCommandId +
                       ' and an outstanding host script cannot be cancelled. Nothing was run for this ' +
                       'command, so it is safe to send again once the panel is idle.'
            });
            return;
        }

        this.log('Processing socket command: ' + command.id, 'info');
        this.addToQueue(command);
        this.isProcessing = true;
        this.currentCommandId = command.id;
        this.currentCommandStartedAt = Date.now();
        this.executeCommand(command, function(result) {
            // The payload is the SAME object the file path writes into response-<uuid>.json, and the
            // server unwraps it by the same rule. Reshaping it here would change what every tool in
            // the catalogue sees, but only on the socket path.
            self.sendSocketFrame({ type: 'response', id: command.id, payload: result });
            self.log('Socket command completed: ' + command.id, 'info');
            self.updateCommandStatus(command.id, 'completed');
            self.isProcessing = false;
            self.currentCommandId = null;
            self.currentCommandStartedAt = null;
        });
    };

    // One tick of the panel's clock. Split out of startCommandPolling so it can be driven directly:
    // a setInterval callback is unreachable from a test, which is how the channel-selection rule
    // below would have gone unverified on this side.
    MCPPremiereBridge.prototype.pollTick = function() {
        // Beat unconditionally — including while processing — so the server can tell a
        // panel that is busy (fresh heartbeat, isProcessing=true) apart from one that
        // has died (heartbeat gone stale). evalScript is async, so this interval keeps
        // firing even while a host-side script is running.
        //
        // The FILE heartbeat is kept whatever the socket is doing, because it is the only
        // liveness signal that survives the socket being down — which is exactly when the
        // question "is the panel alive?" gets asked.
        this.writeHeartbeat();
        if (this.isConnected) this.maintainSocket();
        // While the socket is handshaken the server publishes only over the socket, so scanning
        // for command files here could only ever pick up something stale — or, if a second
        // server were sharing the directory, execute work this connection knows nothing about.
        // Skipping the scan is what makes "exactly one channel" true at both ends.
        if (!this.isProcessing && this.isConnected && !this.socketReady) {
            var tempPath = this.getTempDirectory();
            if (tempPath) this.watchDirectory(tempPath);
        }
    };

    MCPPremiereBridge.prototype.startCommandPolling = function() {
        var self = this;
        setInterval(function() {
            self.pollTick();
        }, 250);
    };

    MCPPremiereBridge.prototype.addToQueue = function(command) {
        this.commandQueue.push({ id: command.id, status: 'pending', queuedAt: Date.now(), script: (command.script || '').substring(0, 50) + '...' });
        this.updateCommandQueueUI();
    };

    // Finished entries are removed rather than left marked 'completed'. Previously nothing
    // ever left commandQueue: it was push-only, so it grew for the lifetime of the panel and
    // heartbeat.queueLength reported a running TOTAL of every command ever seen, not the
    // number still outstanding. That made the field actively misleading — a healthy idle
    // panel would report queueLength in the hundreds, which reads as a deep backlog — and it
    // leaked memory across a long session. Terminal states are dropped; only genuinely
    // outstanding work is counted.
    MCPPremiereBridge.prototype.updateCommandStatus = function(commandId, status) {
        var terminal = (status === 'completed' || status === 'failed' || status === 'error');
        for (var i = 0; i < this.commandQueue.length; i++) {
            if (this.commandQueue[i].id === commandId) {
                if (terminal) {
                    this.commandQueue.splice(i, 1);
                } else {
                    this.commandQueue[i].status = status;
                }
                break;
            }
        }
        // Backstop: if a command ever terminated without reaching this function, the entry
        // would sit pending forever and inflate the count again. Anything older than five
        // minutes cannot still be running — the server's own ceiling is far below that.
        var now = Date.now();
        for (var j = this.commandQueue.length - 1; j >= 0; j--) {
            var entry = this.commandQueue[j];
            if (!entry.queuedAt) { entry.queuedAt = now; continue; }
            if (now - entry.queuedAt > 300000) this.commandQueue.splice(j, 1);
        }
        this.updateCommandQueueUI();
    };

    /**
     * Minimal HTML escaper for text that reaches innerHTML. ES3-safe (no String.raw, no
     * replaceAll, no arrow). Ampersand first, or the other replacements get double-escaped.
     */
    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    MCPPremiereBridge.prototype.updateCommandQueueUI = function() {
        var el = document.getElementById('commandQueue');
        if (!el) return;
        if (this.commandQueue.length === 0) {
            el.innerHTML = '<div class="command-item"><span class="command-label">No commands in queue</span></div>';
            return;
        }
        var html = this.commandQueue.slice(-5).map(function(cmd) {
            // cmd.script is the first 50 characters of SERVER-SUPPLIED script text, so it
            // routinely contains < and & (a comparison, an ExtendScript &&). Interpolated raw,
            // those corrupt the queue markup and can inject elements. Escaped here because
            // this is the only place that text reaches innerHTML.
            return '<div class="command-item"><span class="command-label">' + escapeHtml(cmd.script) +
                '</span><span class="command-status ' + escapeHtml(cmd.status) + '">' + escapeHtml(cmd.status) + '</span></div>';
        }).join('');
        el.innerHTML = html;
    };

    MCPPremiereBridge.prototype.loadConfig = function() {
        try {
            var panelConfigPath = getPanelConfigPath();
            if (fs.existsSync(panelConfigPath)) {
                var panelConfig = JSON.parse(fs.readFileSync(panelConfigPath, 'utf8'));
                if (panelConfig.tempDirectory) {
                    this.tempDirectory = sanitizeTempDirectoryInput(panelConfig.tempDirectory);
                }
            }

            var candidatePaths = this.tempDirectory ? [this.tempDirectory, getDefaultTempPath()] : [getDefaultTempPath()];
            if (process.env.PREMIERE_TEMP_DIR) {
                candidatePaths.push(sanitizeTempDirectoryInput(process.env.PREMIERE_TEMP_DIR));
            }

            for (var i = 0; !this.tempDirectory && i < candidatePaths.length; i++) {
                var candidatePath = sanitizeTempDirectoryInput(candidatePaths[i]);
                if (!candidatePath || !fs.existsSync(candidatePath)) continue;
                var configPath = path.join(candidatePath, 'config.json');
                if (fs.existsSync(configPath)) {
                    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (config.tempDirectory) {
                        this.tempDirectory = sanitizeTempDirectoryInput(config.tempDirectory);
                        break;
                    }
                }
            }

            var tempEl = document.getElementById('tempDirectory');
            if (tempEl) {
                var fieldValue = sanitizeTempDirectoryInput(tempEl.value);
                if (!this.tempDirectory && fieldValue) this.tempDirectory = fieldValue;
                if (this.tempDirectory) {
                    tempEl.value = this.tempDirectory;
                } else {
                    tempEl.value = getDefaultTempPath();
                }
            }
        } catch (e) {}
    };

    MCPPremiereBridge.prototype.saveConfig = function() {
        try {
            var tempEl = document.getElementById('tempDirectory');
            var tempDir = tempEl ? sanitizeTempDirectoryInput(tempEl.value) : '';
            if (tempDir) this.tempDirectory = tempDir;
            var ensuredTempDir = this.getTempDirectory();
            if (!ensuredTempDir) {
                throw new Error('Could not create or access temp directory');
            }
            if (tempEl) tempEl.value = this.tempDirectory;
            fs.writeFileSync(path.join(ensuredTempDir, 'config.json'), JSON.stringify({ tempDirectory: this.tempDirectory }, null, 2));
            fs.writeFileSync(getPanelConfigPath(), JSON.stringify({ tempDirectory: this.tempDirectory }, null, 2));
            this.log('Configuration saved', 'info');
        } catch (e) {
            this.log('Error saving config: ' + e.message, 'error');
        }
    };

    MCPPremiereBridge.prototype.startBridge = function() {
        this.log('Starting MCP Bridge...', 'info');
        // Clearing the in-flight guard unconditionally was a real concurrency bug: a
        // Stop -> Start during a long host script freed the poller to dispatch a SECOND
        // command, and then the first command's completion callback cleared
        // isProcessing/currentCommandId out from under the second. An outstanding
        // evalScript cannot be cancelled, so the honest move is to leave the guard set
        // and say so, rather than pretend the panel is idle.
        if (this.isProcessing && this.currentCommandId) {
            var outstandingFor = this.currentCommandStartedAt
                ? ' (' + Math.round((Date.now() - this.currentCommandStartedAt) / 1000) + 's so far)'
                : '';
            this.log('A host command is still outstanding: ' + this.currentCommandId + outstandingFor +
                '. Keeping the in-flight guard so a second command cannot run concurrently; ' +
                'the queue resumes when it finishes or its watchdog fires.', 'warning');
        } else {
            this.isProcessing = false;
        }
        this.isConnected = true;
        this.updateUI();
        var tempPath = this.getTempDirectory();
        if (!tempPath) {
            this.isConnected = false;
            this.updateUI();
            this.updateServerStatus(false);
            return;
        }
        this.log('Watching: ' + tempPath + ' (must match your MCP client PREMIERE_TEMP_DIR)', 'info');
        // Dial the push channel immediately rather than waiting for the next poll tick, so a bridge
        // started against an already-running server is on the fast path from the first command.
        this.maintainSocket();
        // The Premiere light used to turn green HERE, on the strength of the temp directory
        // existing — which proves nothing about the host. testPremiereConnection() was
        // written to prove it and was never called from anywhere in the panel. A server that
        // refuses to report an unverified edit as done cannot ship a status light that
        // reports an unverified host as ready, so the claim now waits for the round trip.
        if (this.isProcessing && this.currentCommandId) {
            // Do not dispatch a probe alongside an outstanding host script — that is the
            // very thing the guard above exists to prevent. The next completed command
            // proves the host answers anyway.
            this.log('Bridge watching for commands. Host check deferred until the outstanding command finishes.', 'info');
        } else {
            this.updateServerStatus('verifying');
            this.testPremiereConnection();
            this.log('Bridge watching for commands. Verifying the Premiere host responds...', 'info');
        }
    };

    MCPPremiereBridge.prototype.stopBridge = function() {
        this.log('Stopping MCP Bridge...', 'info');
        this.isConnected = false;
        // Close the socket so the server stops choosing it and reports "no panel connected" instead
        // of publishing into a connection nobody is reading.
        this.disconnectSocket();
        if (this.isProcessing && this.currentCommandId) {
            // Same reason as startBridge: stopping the bridge stops us picking up NEW
            // commands. It cannot recall a script already handed to the host.
            this.log('Stopped watching for new commands, but host command ' + this.currentCommandId +
                ' is already running inside Premiere and cannot be cancelled.', 'warning');
        } else {
            this.isProcessing = false;
        }
        this.updateUI();
        this.updateServerStatus(false);
    };

    MCPPremiereBridge.prototype.runDiagnostics = function() {
        var self = this;
        var hostEnvironment = null;
        var report = {
            generatedAt: new Date().toISOString(),
            panel: 'MCP Bridge (CEP)',
            tempDirectory: this.getTempDirectory(),
            hostEnvironment: null,
            checks: []
        };

        function addCheck(name, success, details) {
            report.checks.push({
                name: name,
                success: success,
                details: details
            });
        }

        function finalize() {
            var reportPath = self.writeDiagnosticReport(report);
            if (reportPath) {
                self.log('Diagnostics report saved to ' + reportPath, 'info');
            }
            self.log('Diagnostics summary: ' + JSON.stringify(report), 'info');
        }

        this.log('Running CEP diagnostics...', 'info');

        try {
            hostEnvironment = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            report.hostEnvironment = hostEnvironment;
            addCheck('host_environment', !!hostEnvironment, hostEnvironment || 'No host environment returned');
        } catch (e) {
            addCheck('host_environment', false, e.message);
            finalize();
            return;
        }

        var checks = [
            {
                name: 'eval_string',
                script: '(function(){ return "cep-ok"; })();'
            },
            {
                name: 'app_version_raw',
                script: '(function(){ try { return app.version; } catch (e) { return "ERROR: " + String(e); } })();'
            },
            {
                name: 'eval_json_roundtrip',
                script: '(function(){ return JSON.stringify({ ok: true, transport: "cep" }); })();'
            },
            {
                name: 'app_version',
                script: '(function(){ try { return JSON.stringify({ appVersion: app.version, appName: app.name }); } catch (e) { return JSON.stringify({ error: String(e) }); } })();'
            },
            {
                name: 'project_access',
                script: '(function(){ try { return JSON.stringify({ projectName: (app.project && app.project.name) ? app.project.name : "No project open" }); } catch (e) { return JSON.stringify({ error: String(e) }); } })();'
            }
        ];

        function runCheck(index) {
            if (index >= checks.length) {
                finalize();
                return;
            }

            var check = checks[index];
            self.executeExtendScript(check.script, function(err, result) {
                if (err) {
                    addCheck(check.name, false, err.message);
                } else {
                    addCheck(check.name, true, result);
                }
                runCheck(index + 1);
            });
        }

        runCheck(0);
    };

    MCPPremiereBridge.prototype.testPremiereConnection = function() {
        var self = this;
        var script = '(function() {\
            try {\
                var d = new Date();\
                var timestamp = d.getFullYear() + "-" + \
                    String(d.getMonth() + 1).replace(/^(\\d)$/, "0$1") + "-" + \
                    String(d.getDate()).replace(/^(\\d)$/, "0$1") + "T" + \
                    String(d.getHours()).replace(/^(\\d)$/, "0$1") + ":" + \
                    String(d.getMinutes()).replace(/^(\\d)$/, "0$1") + ":" + \
                    String(d.getSeconds()).replace(/^(\\d)$/, "0$1");\
                var info = {\
                    appVersion: app.version,\
                    projectName: "No project open",\
                    timestamp: timestamp\
                };\
                try {\
                    if (app.project && app.project.name) {\
                        info.projectName = app.project.name;\
                    }\
                } catch(e) {}\
                return JSON.stringify(info);\
            } catch(e) {\
                return JSON.stringify({ error: String(e) });\
            }\
        })();';
        this.executeExtendScript(script, function(err, result) {
            if (err) {
                self.log('Premiere Pro connection failed: ' + err.message, 'error');
                self.updateServerStatus(false);
            } else {
                self.log('Premiere Pro connection OK: ' + JSON.stringify(result), 'info');
                self.updateServerStatus(true);
            }
        });
    };

    MCPPremiereBridge.prototype.updateUI = function() {
        var connectionStatus = document.getElementById('connectionStatus');
        var connectionText = document.getElementById('connectionText');
        if (connectionStatus && connectionText) {
            if (this.isConnected) {
                connectionStatus.className = 'status-dot connected';
                connectionText.textContent = 'Connected';
            } else {
                connectionStatus.className = 'status-dot disconnected';
                connectionText.textContent = 'Disconnected';
            }
        }
        var startBtn = document.getElementById('startButton');
        var stopBtn = document.getElementById('stopButton');
        if (startBtn) startBtn.disabled = this.isConnected;
        if (stopBtn) stopBtn.disabled = !this.isConnected;
        var tempEl = document.getElementById('tempDirectory');
        if (tempEl && !tempEl.value && this.getTempDirectory()) tempEl.value = this.getTempDirectory();
    };

    /**
     * Three states, not two. `true` means the host actually answered an ExtendScript round
     * trip; 'verifying' means we have asked and do not know yet; anything falsy means not
     * proven. 'verifying' deliberately keeps the un-proven dot styling and carries its
     * meaning in the LABEL — a status must never rest on colour alone, and inventing a third
     * dot colour would also need CSS that does not exist yet.
     */
    MCPPremiereBridge.prototype.updateServerStatus = function(state) {
        var serverStatus = document.getElementById('serverStatus');
        var serverText = document.getElementById('serverText');
        if (!serverStatus || !serverText) return;
        if (state === true) {
            serverStatus.className = 'status-dot connected';
            serverText.textContent = 'Premiere Pro: Ready';
        } else if (state === 'verifying') {
            serverStatus.className = 'status-dot disconnected';
            serverText.textContent = 'Premiere Pro: verifying host...';
        } else {
            serverStatus.className = 'status-dot disconnected';
            serverText.textContent = 'Premiere Pro: Start Bridge to enable';
        }
    };

    MCPPremiereBridge.prototype.log = function(message, level) {
        level = level || 'info';
        var logContainer = document.getElementById('logContainer');
        if (logContainer) {
            var el = document.createElement('div');
            el.className = 'log-entry ' + level;
            el.textContent = '[' + new Date().toISOString() + '] ' + message;
            logContainer.appendChild(el);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        console.log(message);
    };

    MCPPremiereBridge.prototype.clearLog = function() {
        var logContainer = document.getElementById('logContainer');
        if (logContainer) logContainer.innerHTML = '<div class="log-entry info">Log cleared</div>';
    };

    // ── Clipboard read via CEP (read-only — write handled Node.js side) ────
    // pbpaste never needs stdin so it's safe to spawn here.
    MCPPremiereBridge.prototype.clipboardRead = function(done) {
        var proc = window.cep.process;
        var pid = proc.createProcess('/usr/bin/pbpaste', []).data;
        var out = '';
        proc.stdout(pid, function(d) { out += d; });
        proc.waitfor(pid, function(code) { done({ success: true, text: out, exitCode: code }); });
        setTimeout(function() { try { proc.terminate(pid); } catch(e){} done({ success: true, text: out, timeout: true }); }, 5000);
    };
    // ──────────────────────────────────────────────────────────────────────

    window.MCPPremiereBridge = MCPPremiereBridge;
    window.bridge = null;
    window.startBridge = function() { if (window.bridge) window.bridge.startBridge(); };
    window.stopBridge = function() { if (window.bridge) window.bridge.stopBridge(); };
    window.runDiagnostics = function() { if (window.bridge) window.bridge.runDiagnostics(); };
    window.saveConfig = function() { if (window.bridge) window.bridge.saveConfig(); };
    window.clearLog = function() { if (window.bridge) window.bridge.clearLog(); };
    document.addEventListener('DOMContentLoaded', function() {
        window.bridge = new MCPPremiereBridge();
    });
})();

