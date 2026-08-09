(function () {
    'use strict';

    if (window.__JellyfinAudioDelay) {
        return;
    }

    const MIN_DELAY_MS = -10000;
    const MAX_DELAY_MS = 10000;
    const MAX_DELAY_SECONDS = MAX_DELAY_MS / 1000;
    const STORAGE_PREFIX = 'jellyfin.audio-delay.v1:';
    const STYLE_ID = 'audio-delay-style';
    const MENU_CLASS = 'audio-delay-menu';
    const PROFILE_ENDPOINT = 'AudioDelay/Profile';
    const state = {
        video: null,
        videoObserver: null,
        videoListeners: [],
        graph: null,
        secondaryAudio: null,
        secondarySource: '',
        secondaryTimer: null,
        customAudio: false,
        savedMuted: false,
        playerMuted: false,
        seriesId: '',
        seasonNumber: null,
        mediaKey: '',
        episodeKey: '',
        currentTrack: null,
        delayMs: 0,
        profile: null,
        profileContext: '',
        profileRequestToken: 0,
        priming: false,
        trackRequestAt: 0,
        trackRequestToken: 0,
        dialogOpenPending: false,
        dialog: null,
        scanTimer: null
    };

    window.__JellyfinAudioDelay = {
        version: '0.1.7.0',
        getState: function () {
            return {
                seriesId: state.seriesId,
                seasonNumber: state.seasonNumber,
                track: state.currentTrack ? state.currentTrack.label : '',
                delayMs: state.delayMs,
                locked: isLocked(),
                audioGraphActive: Boolean(state.graph),
                secondaryAudioActive: Boolean(state.secondaryAudio)
            };
        }
    };

    function clampDelay(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return 0;
        }

        return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(numericValue)));
    }

    function formatDelay(value) {
        const delay = clampDelay(value);
        return `${delay > 0 ? '+' : ''}${delay} ms`;
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeTrackKey(label) {
        return normalizeText(label)
            .replace(/\s*-\s*default\s*$/i, '')
            .toLocaleLowerCase();
    }

    function getApiClient() {
        const apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.getUrl !== 'function') {
            return null;
        }

        if (typeof apiClient.accessToken === 'function' && !apiClient.accessToken()) {
            return null;
        }

        return apiClient;
    }

    function getVideo() {
        return document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer');
    }

    function getMediaContext() {
        const video = state.video;
        if (!video) {
            return null;
        }

        const poster = video.getAttribute('poster') || '';
        const seriesMatch = poster.match(/\/Items\/([0-9a-f-]{32,36})\//i);
        const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
            .map(element => normalizeText(element.textContent))
            .find(text => /\bS\d+\s*:\s*E\d+\b/i.test(text)) || '';
        const seasonMatch = heading.match(/\bS(\d+)\s*:\s*E\d+\b/i);
        const seriesId = seriesMatch ? seriesMatch[1].toLowerCase() : '';
        const seasonNumber = seasonMatch ? Number(seasonMatch[1]) : null;
        const episodeKey = heading || normalizeText(video.getAttribute('src') || '');

        if (!seriesId || !Number.isInteger(seasonNumber)) {
            return null;
        }

        return {
            seriesId,
            seasonNumber,
            mediaKey: `${seriesId}|${seasonNumber}`,
            episodeKey
        };
    }

    function getProfileContext() {
        if (!state.mediaKey || !state.currentTrack) {
            return null;
        }

        return {
            seriesId: state.seriesId,
            seasonNumber: state.seasonNumber,
            trackKey: state.currentTrack.key,
            trackLabel: state.currentTrack.label
        };
    }

    function getStorageKey(context) {
        return STORAGE_PREFIX + encodeURIComponent(
            `${context.seriesId}|${context.seasonNumber}|${context.trackKey}`);
    }

    function readLocalProfile(context) {
        try {
            const raw = window.localStorage.getItem(getStorageKey(context));
            return raw ? normalizeProfile(JSON.parse(raw), context) : null;
        } catch (error) {
            return null;
        }
    }

    function writeLocalProfile(profile) {
        try {
            const context = {
                seriesId: profile.seriesId,
                seasonNumber: profile.seasonNumber,
                trackKey: profile.trackKey
            };
            window.localStorage.setItem(getStorageKey(context), JSON.stringify(profile));
        } catch (error) {
            // The server profile remains authoritative when browser storage is unavailable.
        }
    }

    function removeLocalProfile(context) {
        try {
            window.localStorage.removeItem(getStorageKey(context));
        } catch (error) {
            // The server profile is still removed below.
        }
    }

    function normalizeProfile(rawProfile, context) {
        if (!rawProfile) {
            return null;
        }

        const delay = rawProfile.DelayMilliseconds ?? rawProfile.delayMilliseconds;
        const trackKey = rawProfile.TrackKey || rawProfile.trackKey || context.trackKey;
        const trackLabel = rawProfile.TrackLabel || rawProfile.trackLabel || context.trackLabel;
        if (!trackKey || !Number.isFinite(Number(delay))) {
            return null;
        }

        return {
            seriesId: String(rawProfile.SeriesId || rawProfile.seriesId || context.seriesId).toLowerCase(),
            seasonNumber: Number(rawProfile.SeasonNumber ?? rawProfile.seasonNumber ?? context.seasonNumber),
            trackKey: String(trackKey),
            trackLabel: String(trackLabel),
            delayMilliseconds: clampDelay(delay)
        };
    }

    function profileMatchesContext(profile, context) {
        return Boolean(profile && context &&
            profile.seriesId === context.seriesId &&
            profile.seasonNumber === context.seasonNumber &&
            profile.trackKey === context.trackKey);
    }

    function isLocked() {
        return profileMatchesContext(state.profile, getProfileContext());
    }

    function profileUrl(apiClient, context) {
        const query = [
            `SeriesId=${encodeURIComponent(context.seriesId)}`,
            `SeasonNumber=${encodeURIComponent(context.seasonNumber)}`,
            `TrackKey=${encodeURIComponent(context.trackKey)}`
        ].join('&');
        return apiClient.getUrl(`${PROFILE_ENDPOINT}?${query}`);
    }

    function loadProfile() {
        const context = getProfileContext();
        if (!context) {
            return;
        }

        const requestToken = ++state.profileRequestToken;
        const localProfile = readLocalProfile(context);
        if (localProfile) {
            applyProfile(localProfile);
        }

        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.getJSON !== 'function') {
            return;
        }

        apiClient.getJSON(profileUrl(apiClient, context), true).then(function (rawProfile) {
            if (requestToken !== state.profileRequestToken) {
                return;
            }

            const serverProfile = normalizeProfile(rawProfile, context);
            if (serverProfile) {
                writeLocalProfile(serverProfile);
                applyProfile(serverProfile);
            } else if (!localProfile) {
                state.profile = null;
                updateMenuItem();
                renderDialog();
            }
        }).catch(function () {
            // Local storage still keeps the profile usable during a transient API failure.
        });
    }

    function saveProfileToServer(profile) {
        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.ajax !== 'function') {
            return Promise.resolve();
        }

        return apiClient.ajax({
            type: 'PUT',
            url: apiClient.getUrl(PROFILE_ENDPOINT),
            dataType: 'json',
            contentType: 'application/json',
            data: JSON.stringify({
                SeriesId: profile.seriesId,
                SeasonNumber: profile.seasonNumber,
                TrackKey: profile.trackKey,
                TrackLabel: profile.trackLabel,
                DelayMilliseconds: profile.delayMilliseconds
            })
        });
    }

    function deleteProfileFromServer(context) {
        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.ajax !== 'function') {
            return Promise.resolve();
        }

        return apiClient.ajax({
            type: 'DELETE',
            url: profileUrl(apiClient, context),
            dataType: 'json'
        });
    }

    function applyProfile(profile) {
        const context = getProfileContext();
        if (!profileMatchesContext(profile, context)) {
            return;
        }

        state.profile = profile;
        setDelay(profile.delayMilliseconds);
        renderDialog();
    }

    function setDelay(value) {
        state.delayMs = clampDelay(value);
        applyDelayToPlayer();
        updateMenuItem();
        renderDialog();
    }

    function setLockedProfile() {
        const context = getProfileContext();
        if (!context) {
            setDialogStatus('The current series and season could not be identified.', true);
            return;
        }

        const profile = {
            seriesId: context.seriesId,
            seasonNumber: context.seasonNumber,
            trackKey: context.trackKey,
            trackLabel: context.trackLabel,
            delayMilliseconds: state.delayMs
        };
        state.profile = profile;
        writeLocalProfile(profile);
        updateMenuItem();
        renderDialog();
        setDialogStatus('Locked for this season.', false);

        saveProfileToServer(profile).catch(function () {
            setDialogStatus('Locked in this browser. Jellyfin could not save the server profile.', true);
        });
    }

    function unlockProfile() {
        const context = getProfileContext();
        if (!context) {
            return;
        }

        state.profile = null;
        removeLocalProfile(context);
        updateMenuItem();
        renderDialog();
        setDialogStatus('Unlocked. The current delay remains active for this episode.', false);

        deleteProfileFromServer(context).catch(function () {
            setDialogStatus('Removed in this browser. Jellyfin could not remove the server profile.', true);
        });
    }

    function resetDelay() {
        setDelay(0);
        if (isLocked()) {
            setLockedProfile();
            setDialogStatus('The season lock is now set to 0 ms.', false);
        }
    }

    function ensureAudioGraph() {
        if (!state.video) {
            return null;
        }

        if (state.graph && state.graph.video === state.video) {
            return state.graph;
        }

        if (state.graph) {
            try {
                state.graph.source.disconnect();
                state.graph.delay.disconnect();
                state.graph.context.close();
            } catch (error) {
                // The old graph is no longer connected to the active player.
            }
            state.graph = null;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            return null;
        }

        try {
            const context = new AudioContextClass();
            const source = context.createMediaElementSource(state.video);
            const delay = context.createDelay(MAX_DELAY_SECONDS);
            source.connect(delay);
            delay.connect(context.destination);
            state.graph = { video: state.video, context, source, delay };
            return state.graph;
        } catch (error) {
            state.graph = null;
            return null;
        }
    }

    function resumeAudioGraph(graph) {
        if (!graph || !graph.context || typeof graph.context.resume !== 'function') {
            return;
        }

        graph.context.resume().catch(function () {
            setDialogStatus('The browser did not allow the audio graph to start yet.', true);
        });
    }

    function setGraphDelay(delayMilliseconds) {
        const graph = ensureAudioGraph();
        if (!graph) {
            setDialogStatus('This browser cannot apply an audio delay to the player.', true);
            return;
        }

        const seconds = Math.max(0, delayMilliseconds) / 1000;
        graph.delay.delayTime.setTargetAtTime(seconds, graph.context.currentTime, 0.015);
        resumeAudioGraph(graph);
    }

    function ensureSecondaryAudio() {
        if (!state.video || !state.video.currentSrc || !document.body) {
            return null;
        }

        if (!state.secondaryAudio) {
            const audio = document.createElement('audio');
            audio.className = 'audio-delay-secondary-player';
            audio.preload = 'auto';
            audio.setAttribute('aria-hidden', 'true');
            audio.style.display = 'none';
            audio.addEventListener('loadedmetadata', function () {
                syncSecondaryAudio(true);
            });
            document.body.appendChild(audio);
            state.secondaryAudio = audio;
        }

        const source = state.video.currentSrc;
        if (state.secondarySource !== source) {
            state.secondaryAudio.pause();
            state.secondaryAudio.src = source;
            state.secondaryAudio.load();
            state.secondarySource = source;
        }

        return state.secondaryAudio;
    }

    function enterSecondaryAudio() {
        if (!state.video) {
            return;
        }

        if (!state.customAudio) {
            state.savedMuted = state.video.muted;
            state.playerMuted = state.video.muted;
            state.customAudio = true;
        }

        state.video.muted = true;
        ensureSecondaryAudio();
        syncSecondaryAudio(true);
    }

    function exitSecondaryAudio() {
        if (state.secondaryAudio) {
            state.secondaryAudio.pause();
            state.secondaryAudio.remove();
            state.secondaryAudio = null;
            state.secondarySource = '';
        }

        if (state.customAudio && state.video) {
            state.video.muted = state.playerMuted;
        }

        state.customAudio = false;
    }

    function syncSecondaryAudio(force) {
        const video = state.video;
        const audio = state.secondaryAudio;
        if (!video || !audio || !state.customAudio) {
            return;
        }

        if (state.secondarySource !== video.currentSrc) {
            ensureSecondaryAudio();
            return;
        }

        audio.volume = video.volume;
        audio.muted = state.playerMuted;
        audio.playbackRate = video.playbackRate;

        if (video.paused || video.ended) {
            audio.pause();
            return;
        }

        const targetTime = video.currentTime - (state.delayMs / 1000);
        if (!Number.isFinite(targetTime) || targetTime < 0) {
            audio.pause();
            return;
        }

        const boundedTarget = Number.isFinite(audio.duration) && audio.duration > 0
            ? Math.min(targetTime, Math.max(0, audio.duration - 0.05))
            : targetTime;
        if (force || Math.abs(audio.currentTime - boundedTarget) > 0.3) {
            try {
                audio.currentTime = Math.max(0, boundedTarget);
            } catch (error) {
                return;
            }
        }

        audio.play().catch(function () {
            setDialogStatus('The browser blocked the separate audio track. Press Play once to enable it.', true);
        });
    }

    function applyDelayToPlayer() {
        const video = state.video;
        if (!video) {
            return;
        }

        if (state.delayMs < 0) {
            if (state.graph) {
                setGraphDelay(0);
            }
            enterSecondaryAudio();
            return;
        }

        exitSecondaryAudio();
        if (state.delayMs > 0) {
            setGraphDelay(state.delayMs);
        } else if (state.graph) {
            setGraphDelay(0);
        }
    }

    function onVideoEvent(event) {
        if (event.type === 'volumechange' && state.customAudio && state.video) {
            state.video.muted = true;
        }

        if (event.type === 'play' || event.type === 'canplay' || event.type === 'loadedmetadata') {
            if (state.graph && state.delayMs > 0) {
                resumeAudioGraph(state.graph);
            }
            if (event.type === 'loadedmetadata' && !state.currentTrack) {
                primeTrack();
            }
        }

        if (state.customAudio) {
            syncSecondaryAudio(event.type === 'seeking' || event.type === 'emptied' || event.type === 'loadstart');
        }
    }

    function detachVideo() {
        state.videoListeners.forEach(function (listener) {
            listener.element.removeEventListener(listener.type, listener.handler);
        });
        state.videoListeners = [];
        if (state.videoObserver) {
            state.videoObserver.disconnect();
            state.videoObserver = null;
        }

        exitSecondaryAudio();
        state.video = null;
        state.currentTrack = null;
        state.profile = null;
        state.profileContext = '';
        state.trackRequestToken += 1;
        state.priming = false;
        state.trackRequestAt = 0;
        state.seriesId = '';
        state.seasonNumber = null;
        state.mediaKey = '';
        state.episodeKey = '';
        state.delayMs = 0;
        updateMenuItem();
    }

    function attachVideo(video) {
        if (state.video === video) {
            return;
        }

        if (state.video) {
            detachVideo();
        }

        state.video = video;
        const events = ['canplay', 'emptied', 'ended', 'loadstart', 'loadedmetadata', 'pause', 'play', 'ratechange', 'seeking', 'seeked', 'volumechange'];
        events.forEach(function (type) {
            const handler = onVideoEvent;
            video.addEventListener(type, handler);
            state.videoListeners.push({ element: video, type, handler });
        });
        state.videoObserver = new MutationObserver(scheduleScan);
        state.videoObserver.observe(video, { attributes: true, attributeFilter: ['poster', 'src'] });
        window.setTimeout(function () {
            syncMediaContext();
            primeTrack();
        }, 350);
    }

    function syncMediaContext() {
        const context = getMediaContext();
        if (!context) {
            return;
        }

        const episodeChanged = state.episodeKey && state.episodeKey !== context.episodeKey;
        const mediaChanged = state.mediaKey && state.mediaKey !== context.mediaKey;
        state.seriesId = context.seriesId;
        state.seasonNumber = context.seasonNumber;
        state.mediaKey = context.mediaKey;
        state.episodeKey = context.episodeKey;

        if (episodeChanged || mediaChanged) {
            state.currentTrack = null;
            state.profile = null;
            state.profileContext = '';
            state.delayMs = 0;
            applyDelayToPlayer();
            updateMenuItem();
        }
    }

    function findAudioSheet() {
        return Array.from(document.querySelectorAll('.actionSheet.opened')).find(function (sheet) {
            const title = sheet.querySelector('.actionSheetTitle');
            return title && normalizeText(title.textContent).toLocaleLowerCase() === 'audio';
        }) || null;
    }

    function readTrackButton(button) {
        const label = normalizeText(button.querySelector('.actionSheetItemText')?.textContent || button.textContent);
        if (!label) {
            return null;
        }

        return {
            id: button.getAttribute('data-id') || '',
            label,
            key: normalizeTrackKey(label)
        };
    }

    function readSelectedTrack(sheet) {
        const buttons = Array.from(sheet.querySelectorAll('button.actionSheetMenuItem'));
        const selected = buttons.find(function (button) {
            const icon = button.querySelector('.material-icons.check');
            return icon && window.getComputedStyle(icon).visibility !== 'hidden';
        });
        return readTrackButton(selected || buttons[0]);
    }

    function getSessionTrack() {
        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.getJSON !== 'function') {
            return Promise.resolve(null);
        }

        let deviceId = '';
        try {
            deviceId = typeof apiClient.deviceId === 'function' ? apiClient.deviceId() : '';
        } catch (error) {
            deviceId = '';
        }

        return apiClient.getJSON(apiClient.getUrl('Sessions'), true).then(function (sessions) {
            if (!Array.isArray(sessions)) {
                return null;
            }

            const playingSessions = sessions.filter(function (session) {
                return session && session.NowPlayingItem && session.PlayState;
            });
            const session = playingSessions.find(function (candidate) {
                return deviceId && candidate.DeviceId === deviceId;
            }) || playingSessions[0];
            if (!session) {
                return null;
            }

            const playState = session.PlayState;
            const streamIndex = Number(playState.AudioStreamIndex);
            const item = session.NowPlayingItem;
            const streams = Array.isArray(item.MediaStreams)
                ? item.MediaStreams
                : Array.isArray(item.MediaSources) && item.MediaSources[0]
                    ? item.MediaSources[0].MediaStreams || []
                    : [];
            const audioStreams = streams.filter(function (stream) {
                return stream && String(stream.Type || '').toLocaleLowerCase() === 'audio';
            });
            const selected = Number.isFinite(streamIndex)
                ? audioStreams.find(function (stream) {
                    return Number(stream.Index) === streamIndex;
                })
                : null;
            const stream = selected || audioStreams.find(function (candidate) {
                return candidate.IsDefault;
            }) || audioStreams[0];
            if (!stream) {
                return null;
            }

            const label = normalizeText(stream.DisplayTitle || stream.Title || stream.Language);
            if (!label) {
                return null;
            }

            const id = stream.Index === undefined || stream.Index === null
                ? Number.isFinite(streamIndex) ? String(streamIndex) : ''
                : String(stream.Index);
            return {
                id,
                label,
                key: normalizeTrackKey(label)
            };
        }).catch(function () {
            return null;
        });
    }

    function closeActionSheet(sheet) {
        if (!sheet || !document.body) {
            return;
        }

        const container = sheet.closest('.dialogContainer');
        const backdrop = sheet.backdrop instanceof Element
            ? sheet.backdrop
            : container && container.previousElementSibling &&
                container.previousElementSibling.classList.contains('dialogBackdrop')
                ? container.previousElementSibling
                : null;

        // Jellyfin closes action sheets from an outside pointer gesture rather than
        // from the full-screen dialog container itself.
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (type) {
            document.body.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: 1,
                clientY: 1,
                view: window
            }));
        });

        window.setTimeout(function () {
            if (!sheet.isConnected && (!container || !container.isConnected)) {
                return;
            }

            if (backdrop && backdrop.isConnected) {
                backdrop.remove();
            }
            if (container && container.isConnected) {
                container.remove();
            } else if (sheet.isConnected) {
                sheet.remove();
            }
        }, 450);
    }

    function closeActionSheets() {
        Array.from(document.querySelectorAll('.actionSheet.opened'))
            .reverse()
            .forEach(closeActionSheet);
    }

    function setCurrentTrack(track) {
        if (!track || !track.key) {
            return;
        }

        const changed = !state.currentTrack || state.currentTrack.key !== track.key;
        state.currentTrack = track;
        if (!changed) {
            updateMenuItem();
            renderDialog();
            return;
        }

        state.profile = null;
        state.profileContext = `${state.mediaKey}|${track.key}`;
        state.delayMs = 0;
        applyDelayToPlayer();
        updateMenuItem();
        loadProfile();
    }

    function readOpenAudioSelection() {
        const sheet = findAudioSheet();
        if (sheet) {
            setCurrentTrack(readSelectedTrack(sheet));
        }
    }

    function primeTrack() {
        if (state.currentTrack || state.priming || !state.video || !state.mediaKey) {
            return;
        }

        const existingSheet = findAudioSheet();
        if (existingSheet) {
            setCurrentTrack(readSelectedTrack(existingSheet));
            return;
        }

        if (state.trackRequestAt && Date.now() - state.trackRequestAt < 500) {
            return;
        }

        state.priming = true;
        state.trackRequestAt = Date.now();
        const requestToken = ++state.trackRequestToken;
        getSessionTrack().then(function (track) {
            if (requestToken !== state.trackRequestToken || !state.video || !track) {
                return;
            }

            setCurrentTrack(track);
        }).finally(function () {
            if (requestToken !== state.trackRequestToken) {
                return;
            }

            state.priming = false;
            if (!state.currentTrack) {
                window.setTimeout(function () {
                    state.trackRequestAt = 0;
                    primeTrack();
                }, 500);
            }
        });
    }

    function isVisibleElement(element) {
        if (!element || !element.isConnected) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
    }

    function fitSettingsSheet(sheet) {
        if (!sheet || !sheet.isConnected) {
            return;
        }

        // Jellyfin leaves an inline top offset from the opening animation. Clear it
        // before applying the bottom offset so the sheet keeps its content height.
        sheet.style.setProperty('top', 'auto');
        sheet.style.removeProperty('--audio-delay-sheet-lift');
        const rect = sheet.getBoundingClientRect();
        const item = sheet.querySelector(`.${MENU_CLASS}`);
        const itemRect = item ? item.getBoundingClientRect() : null;
        const viewportBottom = Math.min(
            window.innerHeight,
            document.documentElement.clientHeight || window.innerHeight
        );
        const contentBottom = Math.max(rect.bottom, itemRect ? itemRect.bottom : 0);
        const lift = Math.max(0, contentBottom - (viewportBottom - 8));
        if (lift) {
            sheet.style.setProperty('--audio-delay-sheet-lift', `${Math.ceil(lift)}px`);
        }
    }

    function scheduleSettingsSheetFit(sheet) {
        if (!sheet || sheet.__audioDelayFitFrame) {
            return;
        }

        const requestFrame = window.requestAnimationFrame || function (callback) {
            return window.setTimeout(callback, 0);
        };
        sheet.__audioDelayFitFrame = requestFrame(function () {
            sheet.__audioDelayFitFrame = null;
            fitSettingsSheet(sheet);
        });
    }

    function ensureMenuItem() {
        const statsButton = Array.from(document.querySelectorAll('.actionSheet.opened button[data-id="stats"]'))
            .find(function (button) {
                const sheet = button.closest('.actionSheet');
                return isVisibleElement(button) && isVisibleElement(sheet);
            });
        if (!statsButton) {
            return;
        }

        const sheet = statsButton.closest('.actionSheet');
        const title = sheet?.querySelector('.actionSheetTitle');
        if (!sheet || title) {
            return;
        }

        sheet.classList.add('audio-delay-settings-sheet');

        const scroller = statsButton.parentElement;
        if (!scroller) {
            return;
        }

        if (scroller.querySelector(`.${MENU_CLASS}`)) {
            scheduleSettingsSheetFit(sheet);
            return;
        }

        const item = document.createElement('button');
        item.setAttribute('is', 'emby-button');
        item.type = 'button';
        item.className = 'listItem listItem-button actionSheetMenuItem emby-button ' + MENU_CLASS;
        item.setAttribute('data-id', 'audio-delay');
        item.innerHTML = '<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">Audio Delay</div></div><div class="listItemAside actionSheetItemAsideText">Off</div>';
        item.addEventListener('pointerup', requestDelayDialog);
        item.addEventListener('click', requestDelayDialog);
        statsButton.insertAdjacentElement('afterend', item);
        updateMenuItem();
        scheduleSettingsSheetFit(sheet);
    }

    function updateMenuItem() {
        Array.from(document.querySelectorAll(`.${MENU_CLASS}`)).forEach(function (item) {
            const label = item.querySelector('.actionSheetItemText');
            const aside = item.querySelector('.actionSheetItemAsideText');
            if (label) {
                label.textContent = 'Audio Delay';
            }
            if (aside) {
                aside.textContent = state.delayMs === 0 ? 'Off' : formatDelay(state.delayMs);
            }
        });
    }

    function requestDelayDialog() {
        if (state.dialogOpenPending || state.dialog) {
            return;
        }

        state.dialogOpenPending = true;
        if (!state.currentTrack) {
            // Keep track discovery inside the user gesture. Firefox can reject a
            // later programmatic click after the gesture has already returned.
            primeTrack();
        }

        const wait = state.currentTrack ? 0 : 140;
        window.setTimeout(function () {
            state.dialogOpenPending = false;
            openDelayDialog();
        }, wait);
    }

    function onDocumentClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        if (target.closest(`.${MENU_CLASS}`)) {
            // Let Jellyfin's own action-sheet handler resolve and close this menu item.
            requestDelayDialog();
            return;
        }

        if (target.closest('.btnAudio')) {
            window.setTimeout(readOpenAudioSelection, 80);
            return;
        }

        if (target.closest('.buttonMute')) {
            window.setTimeout(function () {
                if (state.customAudio && state.video) {
                    state.playerMuted = state.video.muted;
                    state.video.muted = true;
                    syncSecondaryAudio(true);
                }
            }, 0);
        }

        const trackButton = target.closest('.actionSheet.opened button.actionSheetMenuItem');
        const sheet = target.closest('.actionSheet.opened');
        const title = sheet?.querySelector('.actionSheetTitle');
        if (trackButton && title && normalizeText(title.textContent).toLocaleLowerCase() === 'audio') {
            const track = readTrackButton(trackButton);
            window.setTimeout(function () {
                setCurrentTrack(track);
            }, 0);
        }
    }

    function scheduleScan() {
        if (state.scanTimer) {
            return;
        }

        state.scanTimer = window.setTimeout(function () {
            state.scanTimer = null;
            scan();
        }, 50);
    }

    function scan() {
        const video = getVideo();
        if (!video) {
            if (state.video) {
                detachVideo();
            }
            return;
        }

        attachVideo(video);
        syncMediaContext();
        ensureMenuItem();
        updateMenuItem();
    }

    function setDialogStatus(message, error) {
        if (!state.dialog) {
            return;
        }

        state.dialog.status.textContent = message || '';
        state.dialog.status.classList.toggle('audio-delay-status-error', Boolean(error));
    }

    function renderDialog() {
        if (!state.dialog) {
            return;
        }

        const delay = state.delayMs;
        state.dialog.range.value = String(delay);
        state.dialog.number.value = String(delay);
        state.dialog.value.textContent = formatDelay(delay);
        state.dialog.track.textContent = state.currentTrack?.label || 'Selected audio track';
        state.dialog.season.textContent = state.seasonNumber === null
            ? 'Current season'
            : `Season ${state.seasonNumber}`;
        const locked = isLocked();
        const label = state.dialog.lock.querySelector('.audio-delay-lock-label');
        if (label) {
            label.textContent = locked ? 'Unlock for this season' : 'Lock for this season';
        }
        const icon = state.dialog.lock.querySelector('.material-icons');
        if (icon) {
            icon.textContent = locked ? 'lock_open' : 'lock';
        }
    }

    function openDelayDialog(attempt) {
        const currentAttempt = Number.isInteger(attempt) ? attempt : 0;

        if (state.dialog) {
            renderDialog();
            return;
        }

        if (document.querySelector('.actionSheet.opened')) {
            closeActionSheets();
            if (currentAttempt < 20) {
                window.setTimeout(function () {
                    openDelayDialog(currentAttempt + 1);
                }, 80);
            }
            return;
        }

        if (!state.currentTrack) {
            primeTrack();
            if (currentAttempt < 20) {
                window.setTimeout(function () {
                    openDelayDialog(currentAttempt + 1);
                }, 80);
            }
            return;
        }

        openDelayDialogNow();
    }

    function openDelayDialogNow() {
        if (!state.currentTrack) {
            return;
        }

        if (state.dialog) {
            renderDialog();
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'dialogContainer audio-delay-overlay';
        overlay.innerHTML = `
            <div class="focuscontainer dialog opened audio-delay-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-delay-title">
                <div class="formDialogHeader audio-delay-dialog-header">
                    <h3 id="audio-delay-title" class="formDialogHeaderTitle">Audio Delay</h3>
                    <button is="paper-icon-button-light" type="button" class="paper-icon-button-light audio-delay-close" title="Close" aria-label="Close">
                        <span class="material-icons">close</span>
                    </button>
                </div>
                <div class="formDialogContent smoothScrollY audio-delay-dialog-content">
                    <div class="dialogContentInner">
                        <div class="audio-delay-track" aria-live="polite"></div>
                        <div class="fieldDescription audio-delay-season"></div>
                        <div class="inputContainer audio-delay-control">
                            <label class="inputLabel inputLabelUnfocused" for="audio-delay-range">Delay</label>
                            <div class="audio-delay-inputs">
                                <input is="emby-slider" class="emby-slider audio-delay-range" id="audio-delay-range" type="range" min="${MIN_DELAY_MS}" max="${MAX_DELAY_MS}" step="10" aria-label="Audio delay">
                                <div class="audio-delay-number-field">
                                    <input is="emby-input" class="emby-input audio-delay-number" id="audio-delay-number" type="number" min="${MIN_DELAY_MS}" max="${MAX_DELAY_MS}" step="1" aria-label="Audio delay in milliseconds">
                                    <span class="audio-delay-unit">ms</span>
                                </div>
                            </div>
                            <div class="audio-delay-value fieldDescription" aria-live="polite"></div>
                        </div>
                        <div class="audio-delay-status fieldDescription" role="status" aria-live="polite"></div>
                        <div class="audio-delay-actions">
                            <button is="emby-button" type="button" class="raised button-cancel emby-button audio-delay-reset"><span class="material-icons">restart_alt</span><span>Reset</span></button>
                            <button is="emby-button" type="button" class="raised button-submit emby-button audio-delay-lock"><span class="material-icons">lock</span><span class="audio-delay-lock-label">Lock for this season</span></button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const dialog = overlay.querySelector('.audio-delay-dialog');
        state.dialog = {
            overlay,
            dialog,
            close: overlay.querySelector('.audio-delay-close'),
            range: overlay.querySelector('#audio-delay-range'),
            number: overlay.querySelector('#audio-delay-number'),
            value: overlay.querySelector('.audio-delay-value'),
            track: overlay.querySelector('.audio-delay-track'),
            season: overlay.querySelector('.audio-delay-season'),
            status: overlay.querySelector('.audio-delay-status'),
            reset: overlay.querySelector('.audio-delay-reset'),
            lock: overlay.querySelector('.audio-delay-lock')
        };

        state.dialog.close.addEventListener('click', closeDelayDialog);
        state.dialog.reset.addEventListener('click', resetDelay);
        state.dialog.lock.addEventListener('click', function () {
            if (isLocked()) {
                unlockProfile();
            } else {
                setLockedProfile();
            }
        });
        state.dialog.range.addEventListener('input', function () {
            setDelay(state.dialog.range.value);
        });
        state.dialog.number.addEventListener('input', function () {
            setDelay(state.dialog.number.value);
        });
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) {
                closeDelayDialog();
            }
        });
        dialog.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                closeDelayDialog();
            }
        });
        renderDialog();
        state.dialog.range.focus();
    }

    function closeDelayDialog() {
        if (!state.dialog) {
            return;
        }

        state.dialog.overlay.remove();
        state.dialog = null;
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .audio-delay-overlay {
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                padding: 1em;
                background: rgba(0, 0, 0, .62);
                isolation: isolate;
                pointer-events: auto;
            }
            .audio-delay-settings-sheet {
                bottom: var(--audio-delay-sheet-lift, 0px);
                min-height: 0;
            }
            .audio-delay-settings-sheet .actionSheetContent {
                min-height: 0;
                max-height: calc(100vh - 1em);
            }
            .audio-delay-settings-sheet .actionSheetScroller {
                min-height: 0;
                max-height: calc(100vh - 5em);
                overflow-y: auto;
                overscroll-behavior: contain;
            }
            .audio-delay-dialog {
                position: relative;
                pointer-events: auto;
                box-sizing: border-box;
                width: min(30em, calc(100vw - 2em));
                height: auto;
                min-height: 0;
                max-height: calc(100vh - 2em);
                overflow: hidden;
            }
            .audio-delay-dialog-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: .75em;
                box-sizing: border-box;
                padding: .85em 1em .65em 1.35em;
            }
            .audio-delay-dialog-header .formDialogHeaderTitle {
                flex: 1 1 auto;
                margin: 0;
            }
            .audio-delay-close {
                flex: 0 0 auto;
            }
            .audio-delay-dialog-content {
                max-height: calc(100vh - 6em);
                overflow-y: auto;
                overscroll-behavior: contain;
            }
            .audio-delay-dialog .dialogContentInner {
                padding: .85em 1.5em 1.35em;
            }
            .audio-delay-track {
                overflow-wrap: anywhere;
                font-size: 1em;
            }
            .audio-delay-season {
                margin-top: .35em;
            }
            .audio-delay-control {
                margin: 1.1em 0 0;
            }
            .audio-delay-inputs {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 8.25em;
                align-items: center;
                gap: .75em;
                margin-top: .35em;
            }
            .audio-delay-range {
                width: 100%;
                min-width: 0;
            }
            .audio-delay-number-field {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                gap: .45em;
                min-width: 0;
            }
            .audio-delay-number {
                width: 100%;
                min-width: 0;
                margin: 0;
            }
            .audio-delay-unit {
                opacity: .7;
            }
            .audio-delay-value {
                margin-top: .35em;
                font-variant-numeric: tabular-nums;
            }
            .audio-delay-status {
                margin-top: .85em;
            }
            .audio-delay-status:empty {
                display: none;
            }
            .audio-delay-status-error {
                color: #ffb4ab;
            }
            .audio-delay-actions {
                display: flex;
                flex-wrap: wrap;
                justify-content: flex-end;
                gap: .65em;
                margin-top: 1em;
            }
            .audio-delay-actions button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: .45em;
            }
            .audio-delay-actions .material-icons {
                font-size: 1.1em;
            }
            @media (max-width: 30em) {
                .audio-delay-inputs {
                    grid-template-columns: minmax(0, 1fr);
                    gap: .6em;
                }
                .audio-delay-number-field {
                    width: 8.25em;
                    justify-self: end;
                }
                .audio-delay-actions {
                    justify-content: stretch;
                }
                .audio-delay-actions button {
                    flex: 1 1 10em;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function start() {
        addStyles();
        document.addEventListener('click', onDocumentClick, true);
        new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('resize', function () {
            const sheet = document.querySelector('.actionSheet.opened.audio-delay-settings-sheet');
            scheduleSettingsSheetFit(sheet);
        });
        state.secondaryTimer = window.setInterval(function () {
            if (state.customAudio) {
                syncSecondaryAudio(false);
            }
        }, 100);
        scan();
        window.setInterval(scan, 500);
    }

    start();
}());
