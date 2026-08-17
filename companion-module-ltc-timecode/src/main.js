const { InstanceBase, Regex, InstanceStatus } = require('@companion-module/base')
const WebSocket = require('ws')

const UpgradeScripts = require('./upgrades')
const UpdateVariableDefinitions = require('./variables')
const UpdateFeedbacks = require('./feedbacks')

const RECONNECT_DELAY_MS = 2000
// If the server hasn't been updated to broadcast decoded `tc` frames yet
// (i.e. it's only sending raw `{ bytes }` MIDI), fall back to "disconnected"
// after this long so the module doesn't sit there silently doing nothing.
const NO_DATA_TIMEOUT_MS = 5000

class LtcTimecodeInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Shared state read by feedbacks.js
		this.timecodeState = {
			connected: false,
			running: false,
		}
	}

	async init(config, _isFirstInit, _secrets) {
		this.config = config

		this.updateVariableDefinitions()
		this.updateFeedbacks()

		this.warnedAboutRawBytes = false
		this.initWebSocket()
	}

	async configUpdated(config, _secrets) {
		this.config = config
		this.initWebSocket()
	}

	async destroy() {
		this.clearTimers()
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
			this.ws = null
		}
	}

	// Return config fields for the web config UI
	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Info',
				value:
					'Connects to an LTC-server (btownsdin/LTC-server) instance over WebSocket and reads its live timecode. ' +
					'Requires a server build that broadcasts decoded `tc` frames (not just raw MIDI bytes).',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Server IP / hostname',
				width: 8,
				default: '127.0.0.1',
				regex: Regex.SOMETHING,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Port',
				width: 4,
				default: '8085',
				regex: Regex.PORT,
			},
		]
	}

	updateVariableDefinitions() {
		UpdateVariableDefinitions(this)
	}

	updateFeedbacks() {
		UpdateFeedbacks(this)
	}

	clearTimers() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.noDataTimer) {
			clearTimeout(this.noDataTimer)
			this.noDataTimer = null
		}
	}

	initWebSocket() {
		this.clearTimers()
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
			this.ws = null
		}

		const host = this.config?.host
		const port = this.config?.port
		if (!host || !port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing server IP or port')
			return
		}

		const url = `ws://${host}:${port}`
		this.log('debug', `Connecting to ${url}`)
		this.updateStatus(InstanceStatus.Connecting)

		try {
			this.ws = new WebSocket(url)
		} catch (e) {
			this.log('error', `Could not open WebSocket: ${e.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure)
			this.scheduleReconnect()
			return
		}

		this.ws.on('open', () => {
			this.log('info', `Connected to LTC-server at ${url}`)
			this.timecodeState.connected = true
			this.updateStatus(InstanceStatus.Ok)
			this.setVariableValues({ status: 'Connected (waiting for timecode)' })
			this.checkFeedbacks('timecode_disconnected')
			this.armNoDataTimeout()
		})

		this.ws.on('message', (data) => {
			this.armNoDataTimeout()

			let msg
			try {
				msg = JSON.parse(data)
			} catch (e) {
				this.log('debug', `Ignoring non-JSON message: ${e.message}`)
				return
			}

			if (msg && msg.tc) {
				this.handleTimecodeFrame(msg)
			} else if (msg && msg.bytes && !this.warnedAboutRawBytes) {
				// Server is only sending raw MIDI bytes — it needs the
				// server-side decode patch to work with this module.
				this.warnedAboutRawBytes = true
				this.log(
					'warn',
					'Received raw MIDI bytes from the server but no decoded `tc` field. ' +
						'Update server.js to broadcast decoded timecode (see companion-module-ltc-timecode/README.md).'
				)
			}
		})

		this.ws.on('close', () => {
			this.log('warn', 'WebSocket connection closed, will retry')
			this.timecodeState.connected = false
			this.timecodeState.running = false
			this.updateStatus(InstanceStatus.Disconnected)
			this.setVariableValues({ status: 'Disconnected' })
			this.checkFeedbacks('timecode_running', 'timecode_disconnected')
			this.scheduleReconnect()
		})

		this.ws.on('error', (err) => {
			this.log('error', `WebSocket error: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
	}

	scheduleReconnect() {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.initWebSocket()
		}, RECONNECT_DELAY_MS)
	}

	// If we stop hearing anything at all from the server (not even raw
	// bytes), treat it the same as a dropped connection.
	armNoDataTimeout() {
		if (this.noDataTimer) clearTimeout(this.noDataTimer)
		this.noDataTimer = setTimeout(() => {
			this.log('warn', 'No data received from server, marking disconnected')
			this.timecodeState.connected = false
			this.timecodeState.running = false
			this.updateStatus(InstanceStatus.Disconnected, 'No data from server')
			this.setVariableValues({ status: 'Disconnected' })
			this.checkFeedbacks('timecode_running', 'timecode_disconnected')
		}, NO_DATA_TIMEOUT_MS)
	}

	handleTimecodeFrame(msg) {
		const pad2 = (n) => String(n ?? 0).padStart(2, '0')
		const { h, m, s, f } = msg.tc

		const running = typeof msg.running === 'boolean' ? msg.running : true
		this.timecodeState.connected = true
		this.timecodeState.running = running

		this.setVariableValues({
			timecode: msg.timecode || `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`,
			hours: pad2(h),
			minutes: pad2(m),
			seconds: pad2(s),
			frames: pad2(f),
			fps: msg.fps != null ? String(msg.fps) : '--',
			status: running ? 'Running' : 'Paused',
		})

		this.checkFeedbacks('timecode_running', 'timecode_disconnected')
	}
}

// As of @companion-module/base v2.x, runEntrypoint() no longer exists.
// Companion's module-host dynamically imports this file and expects the
// module class itself as the export (module.exports, read as `.default`
// when imported from ESM), with any upgrade scripts attached as a static
// `UpgradeScripts` property on that same export.
module.exports = LtcTimecodeInstance
module.exports.UpgradeScripts = UpgradeScripts
