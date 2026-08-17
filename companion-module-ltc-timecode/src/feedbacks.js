module.exports = function (self) {
	self.setFeedbackDefinitions({
		timecode_running: {
			type: 'boolean',
			name: 'Timecode is running',
			description: 'Changes button style while timecode is actively running (vs. paused/stopped)',
			defaultStyle: {
				bgcolor: 0x009933, // green
				color: 0xffffff,
			},
			options: [],
			callback: () => {
				return self.timecodeState.running === true
			},
		},
		timecode_disconnected: {
			type: 'boolean',
			name: 'Disconnected from LTC-server',
			description: 'Changes button style while the WebSocket connection to the server is down',
			defaultStyle: {
				bgcolor: 0xcc0000, // red
				color: 0xffffff,
			},
			options: [],
			callback: () => {
				return self.timecodeState.connected === false
			},
		},
	})
}
