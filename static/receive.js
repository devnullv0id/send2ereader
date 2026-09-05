var keyOutput = document.getElementById('keyoutput')
var keyGenBtn = document.getElementById('keygen')
var downloads = document.getElementById('downloads')
var downloadlink = document.getElementById('downloadlink')
var downloadname = document.getElementById('downloadname')
var urlsnode = document.getElementById('urls')
var urllist = document.getElementById('urllist')
var siteurl = document.getElementById('siteurl')
var key = null
var pollTimer = null
var placeholder = '––––'
var renderedUrls = ''

function setPlaceholder(text) {
	keyOutput.textContent = text
	keyOutput.className = 'waiting'
}

function resetKey() {
	if (pollTimer) clearInterval(pollTimer)
	pollTimer = null
	key = null
	setPlaceholder(placeholder)
	downloads.style.display = 'none'
	downloadlink.href = ''
	downloadname.textContent = ''
	renderUrls([])
}

function renderUrls(urls) {
	var joined = urls.join('\n')
	if (joined === renderedUrls) return
	renderedUrls = joined

	while (urllist.firstChild) urllist.removeChild(urllist.firstChild)
	if (urls.length === 0) {
		urlsnode.style.display = 'none'
		return
	}
	urlsnode.style.display = 'block'

	for (var i = 0; i < urls.length; i++) {
		var link = document.createElement('a')
		link.href = urls[i]
		link.target = '_blank'
		link.textContent = urls[i]
		link.className = 'downloadlink'
		urllist.appendChild(link)
	}
}

function applyStatus(data) {
	if (data.file) {
		downloads.style.display = 'block'
		downloadname.textContent = data.file.name
		downloadlink.href = './download/' + encodeURIComponent(data.file.name) + '?key=' + key
	} else {
		downloads.style.display = 'none'
	}
	renderUrls(data.urls && data.urls.length > 0 ? data.urls : [])
}

function pollFile() {
	if (!key) return
	var asked = key
	xhr('GET', './status/' + asked, function (x) {
		if (asked !== key) return

		if (x.status === 404) {
			generateKey()
			return
		}
		if (x.status !== 200) return

		var data
		try {
			data = JSON.parse(x.responseText)
		} catch (err) {
			return
		}
		if (data.error) {
			generateKey()
			return
		}
		applyStatus(data)
	})
}

function startPolling() {
	if (pollTimer) clearInterval(pollTimer)
	pollTimer = setInterval(pollFile, 2 * 1000)
}

function rememberKey(value) {
	if (window.history && window.history.replaceState) {
		window.history.replaceState(null, '', '#' + value)
	} else {
		window.location.hash = value
	}
}

function showKey(value) {
	key = value
	keyOutput.textContent = value
	keyOutput.className = ''
	placeholder = new Array(value.length + 1).join('–')
	rememberKey(value)
	startPolling()
}

function generateKey() {
	resetKey()
	setPlaceholder('…')
	xhr('POST', './generate', function (x) {
		if (x.status === 200 && x.responseText && x.responseText !== 'error') {
			showKey(x.responseText)
		} else {
			setPlaceholder('error')
		}
		keyGenBtn.blur()
	})
}

function keyFromAddress() {
	var raw = window.location.hash.replace('#', '').toUpperCase()
	return /^[A-Z0-9]{1,16}$/.test(raw) ? raw : null
}

function resumeOrGenerate() {
	var previous = keyFromAddress()
	if (!previous) {
		generateKey()
		return
	}
	setPlaceholder('…')
	xhr('GET', './status/' + previous, function (x) {
		if (x.status !== 200) {
			generateKey()
			return
		}
		var data
		try {
			data = JSON.parse(x.responseText)
		} catch (err) {
			generateKey()
			return
		}
		if (data.error) {
			generateKey()
			return
		}
		showKey(previous)
		applyStatus(data)
	})
}

window.onload = function () {
	keyGenBtn.onclick = generateKey
	resumeOrGenerate()
}

siteurl.textContent = window.location.protocol + '//' + window.location.host + '/'
siteurl.href = window.location.protocol + '//' + window.location.host + '/'
siteurl.target = '_self'
