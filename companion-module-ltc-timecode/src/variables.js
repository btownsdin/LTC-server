module.exports = function (self) {
	self.setVariableDefinitions({
		timecode: { name: 'Timecode (HH:MM:SS:FF)' },
		hours: { name: 'Hours' },
		minutes: { name: 'Minutes' },
		seconds: { name: 'Seconds' },
		frames: { name: 'Frames' },
		fps: { name: 'Frame rate' },
		status: { name: 'Status (Running / Paused / Disconnected)' },
	})

	// Sensible defaults so buttons don't show "undefined" before the first
	// message arrives from the server.
	self.setVariableValues({
		timecode: '--:--:--:--',
		hours: '--',
		minutes: '--',
		seconds: '--',
		frames: '--',
		fps: '--',
		status: 'Disconnected',
	})
}
