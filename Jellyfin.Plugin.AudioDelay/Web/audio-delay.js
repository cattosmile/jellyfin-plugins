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
        graphPending: null,
        graphRequestToken: 0,
        secondaryAudio: null,
        secondarySource: '',
        secondaryTimer: null,
        secondaryPending: false,
        secondaryStarting: false,
        customAudio: false,
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
        version: '0.1.12.0',
        getState: function () {
            return {
                seriesId: state.seriesId,
                seasonNumber: state.seasonNumber,
                seasonLockable: isSeasonLockable(),
                track: state.currentTrack ? state.currentTrack.label : '',
                delayMs: state.delayMs,
                locked: isLocked(),
                audioGraphActive: Boolean(state.graph),
                audioGraphPending: Boolean(state.graphPending),
                audioGraphState: state.graph?.context?.state || '',
                audioGraphBypass: Boolean(state.graph?.bypass),
                secondaryAudioActive: state.customAudio,
                secondaryAudioPending: state.secondaryPending,
                videoMuted: Boolean(state.video?.muted)
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
        const mediaId = seriesMatch ? seriesMatch[1].toLowerCase() : '';
        const parsedSeasonNumber = seasonMatch ? Number(seasonMatch[1]) : null;
        const isSeries = Boolean(mediaId && Number.isInteger(parsedSeasonNumber));
        const seriesId = isSeries ? mediaId : '';
        const seasonNumber = isSeries ? parsedSeasonNumber : null;
        const mediaSource = normalizeText(video.currentSrc || video.getAttribute('src') || '');
        const episodeKey = heading || mediaId || mediaSource;

        if (!episodeKey) {
            return null;
        }

        return {
            seriesId,
            seasonNumber,
            mediaKey: isSeries ? `${seriesId}|${seasonNumber}` : `media|${mediaId || mediaSource}`,
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
            trackLabel: state.currentTrack.label,
            lockable: isSeasonLockable()
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
        const context = getProfileContext();
        return Boolean(context?.lockable && profileMatchesContext(state.profile, context));
    }

    function isSeasonLockable() {
        return Boolean(state.seriesId && Number.isInteger(state.seasonNumber));
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
        if (!context || !context.lockable) {
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
            url: profileUrl(apiClient, context)
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
        setDialogStatus('', false);
        applyDelayToPlayer();
        updateMenuItem();
        renderDialog();
    }

    function setDelayFromNumberInput(value) {
        const rawValue = String(value ?? '').trim();
        if (!rawValue || rawValue === '-' || rawValue === '+') {
            return;
        }

        const numericValue = Number(rawValue);
        if (!Number.isFinite(numericValue)) {
            return;
        }

        const requestedDelay = clampDelay(numericValue);
        state.delayMs = requestedDelay;
        setDialogStatus('', false);
        applyDelayToPlayer();
        updateMenuItem();
        renderDialog(state.delayMs === requestedDelay);
    }

    function setLockedProfile() {
        const context = getProfileContext();
        if (!context || !context.lockable) {
            setDialogStatus('Season locks are only available for series episodes.', true);
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
        if (!context || !context.lockable) {
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

    function closeAudioGraph() {
        state.graphRequestToken += 1;
        if (state.graphPending) {
            state.graphPending.context.close().catch(function () {
                // The pending context may already have closed itself.
            });
            state.graphPending = null;
        }

        if (!state.graph) {
            return;
        }

        try {
            state.graph.source.disconnect();
        } catch (error) {
            // The source may already be disconnected while the video is removed.
        }
        try {
            state.graph.delay?.disconnect();
        } catch (error) {
            // A bypass graph has no active delay connection.
        }
        state.graph.context.close().catch(function () {
            // The context may already have closed with the player.
        });
        state.graph = null;
    }

    function applyGraphDelay(graph, delayMilliseconds) {
        if (!graph?.delay || graph.bypass) {
            return false;
        }

        const seconds = Math.max(0, delayMilliseconds) / 1000;
        graph.delay.delayTime.setTargetAtTime(seconds, graph.context.currentTime, 0.015);
        return true;
    }

    function failAudioGraphStart(context, video, source, delay, message) {
        state.graphPending = null;

        let bypass = false;
        if (source) {
            try {
                source.connect(context.destination);
                bypass = true;
            } catch (error) {
                // Keep the context alive if the browser already claimed the media element.
            }
        }

        if (bypass) {
            try {
                if (delay) {
                    source.disconnect(delay);
                    delay.disconnect();
                }
            } catch (error) {
                // The failed delay path may never have completed its connection.
            }
            state.graph = { video, context, source, delay: null, bypass: true };
        } else if (!source) {
            context.close().catch(function () {});
        }

        if (state.delayMs > 0) {
            state.delayMs = 0;
            updateMenuItem();
            renderDialog();
        }
        setDialogStatus(message, true);
    }

    function resumeAudioGraph(graph) {
        if (!graph || graph.context.state === 'running' || typeof graph.context.resume !== 'function') {
            return;
        }

        graph.context.resume().catch(function () {
            setDialogStatus('Firefox paused the audio processor. Press Play once to resume it.', true);
        });
    }

    function startAudioGraph() {
        const video = state.video;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!video || !AudioContextClass) {
            setDialogStatus('This browser cannot apply an audio delay to the player.', true);
            return false;
        }

        if (state.graphPending?.video === video) {
            return true;
        }

        let context = null;
        try {
            context = new AudioContextClass();
        } catch (error) {
            setDialogStatus('Firefox could not create the audio processor. The original audio remains active.', true);
            return false;
        }

        const requestToken = ++state.graphRequestToken;
        state.graphPending = { video, context, requestToken };
        let timeoutId = null;
        const timeout = new Promise(function (_, reject) {
            timeoutId = window.setTimeout(function () {
                reject(new Error('AudioContext resume timed out.'));
            }, 1000);
        });
        let resume = null;
        try {
            resume = context.state === 'running'
                ? Promise.resolve()
                : Promise.resolve(context.resume());
        } catch (error) {
            state.graphPending = null;
            context.close().catch(function () {});
            setDialogStatus('Firefox could not start the audio processor. The original audio remains active.', true);
            return false;
        }

        Promise.race([resume, timeout]).then(function () {
            if (requestToken !== state.graphRequestToken || state.video !== video || state.delayMs <= 0) {
                context.close().catch(function () {});
                return;
            }
            if (context.state !== 'running') {
                throw new Error('AudioContext did not enter the running state.');
            }

            let source = null;
            let delay = null;
            try {
                source = context.createMediaElementSource(video);

                // Keep a proven direct path until the delayed path is complete. A
                // MediaElementSource cannot be detached back to native playback.
                source.connect(context.destination);
                delay = context.createDelay(MAX_DELAY_SECONDS);
                delay.delayTime.setValueAtTime(state.delayMs / 1000, context.currentTime);
                delay.connect(context.destination);
                source.connect(delay);
                source.disconnect(context.destination);

                state.graph = { video, context, source, delay, bypass: false };
                state.graphPending = null;
            } catch (error) {
                failAudioGraphStart(
                    context,
                    video,
                    source,
                    delay,
                    'Firefox could not connect the audio processor. The original audio remains active.'
                );
            }
        }).catch(function () {
            if (requestToken !== state.graphRequestToken) {
                return;
            }
            state.graphPending = null;
            context.close().catch(function () {});
            setDialogStatus('Firefox could not start the audio processor. The original audio remains active.', true);
        }).finally(function () {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
        });
        return true;
    }

    function setGraphDelay(delayMilliseconds) {
        if (delayMilliseconds <= 0 && state.graphPending) {
            state.graphRequestToken += 1;
            state.graphPending.context.close().catch(function () {});
            state.graphPending = null;
        }

        if (state.graph && state.graph.video === state.video) {
            if (!applyGraphDelay(state.graph, delayMilliseconds)) {
                setDialogStatus('The audio processor is in safe bypass mode. The original audio remains active.', true);
                return false;
            }
            resumeAudioGraph(state.graph);
            return true;
        }

        if (delayMilliseconds <= 0) {
            return true;
        }

        return startAudioGraph();
    }

    function ensureSecondaryAudio() {
        if (!state.video || !state.video.currentSrc || !document.body) {
            return null;
        }

        const source = state.video.currentSrc;
        if (/^blob:/i.test(source)) {
            setDialogStatus('Negative delay is unavailable for this Jellyfin playback mode. The original audio was left unchanged.', true);
            return null;
        }

        if (!state.secondaryAudio) {
            const audio = document.createElement('audio');
            audio.className = 'audio-delay-secondary-player';
            audio.preload = 'auto';
            audio.setAttribute('aria-hidden', 'true');
            audio.style.display = 'none';
            audio.addEventListener('loadedmetadata', activateSecondaryAudio);
            audio.addEventListener('canplay', activateSecondaryAudio);
            audio.addEventListener('error', function () {
                failSecondaryAudio('The separate audio stream failed. The original audio was restored.');
            });
            document.body.appendChild(audio);
            state.secondaryAudio = audio;
        }

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
            return false;
        }

        if (state.customAudio) {
            syncSecondaryAudio(true);
            return true;
        }

        if (state.secondaryPending) {
            activateSecondaryAudio();
            return true;
        }

        const audio = ensureSecondaryAudio();
        if (!audio) {
            return false;
        }

        state.playerMuted = state.video.muted;
        state.secondaryPending = true;
        audio.volume = state.video.volume;
        audio.muted = true;
        audio.playbackRate = state.video.playbackRate;
        if (audio.readyState >= 1) {
            activateSecondaryAudio();
        }
        return true;
    }

    function exitSecondaryAudio() {
        const restoreVideoMute = state.customAudio;
        state.customAudio = false;
        state.secondaryPending = false;
        state.secondaryStarting = false;

        const audio = state.secondaryAudio;
        state.secondaryAudio = null;
        state.secondarySource = '';
        if (audio) {
            audio.pause();
            audio.remove();
        }

        if (restoreVideoMute && state.video) {
            state.video.muted = state.playerMuted;
        }
    }

    function failSecondaryAudio(message) {
        const hadSecondaryAudio = state.customAudio || state.secondaryPending;
        exitSecondaryAudio();
        if (hadSecondaryAudio && state.delayMs < 0) {
            state.delayMs = 0;
            updateMenuItem();
            renderDialog();
        }
        setDialogStatus(message, true);
    }

    function getSecondaryTargetTime(video, audio) {
        const targetTime = video.currentTime - (state.delayMs / 1000);
        if (!Number.isFinite(targetTime) || targetTime < 0) {
            return null;
        }

        return Number.isFinite(audio.duration) && audio.duration > 0
            ? Math.min(targetTime, Math.max(0, audio.duration - 0.05))
            : targetTime;
    }

    function activateSecondaryAudio() {
        const video = state.video;
        const audio = state.secondaryAudio;
        if (!video || !audio || !state.secondaryPending || state.secondaryStarting || state.delayMs >= 0) {
            return;
        }
        if (video.paused || video.ended || audio.readyState < 1) {
            return;
        }

        const targetTime = getSecondaryTargetTime(video, audio);
        if (targetTime === null) {
            return;
        }

        state.secondaryStarting = true;
        try {
            audio.currentTime = Math.max(0, targetTime);
        } catch (error) {
            state.secondaryStarting = false;
            failSecondaryAudio('The separate audio stream could not be synchronized. The original audio was restored.');
            return;
        }

        audio.play().then(function () {
            if (state.secondaryAudio !== audio || state.video !== video || state.delayMs >= 0) {
                audio.pause();
                return;
            }

            state.secondaryPending = false;
            state.secondaryStarting = false;
            state.customAudio = true;
            video.muted = true;
            audio.muted = state.playerMuted;
            updateCustomMuteButtons();
        }).catch(function () {
            state.secondaryStarting = false;
            failSecondaryAudio('The separate audio stream could not start. The original audio was restored.');
        });
    }

    function updateCustomMuteButtons(button) {
        const buttons = button
            ? [button]
            : Array.from(document.querySelectorAll('.buttonMute'));
        buttons.forEach(function (muteButton) {
            const icon = muteButton.querySelector('.material-icons');
            const label = state.playerMuted ? 'Unmute' : 'Mute';
            muteButton.setAttribute('aria-label', label);
            muteButton.setAttribute('title', label);
            if (icon) {
                icon.textContent = state.playerMuted ? 'volume_off' : 'volume_up';
            }
        });
    }

    function syncSecondaryAudio(force) {
        const video = state.video;
        const audio = state.secondaryAudio;
        if (!video || !audio || !state.customAudio) {
            return;
        }

        if (state.secondarySource !== video.currentSrc) {
            failSecondaryAudio('The playback source changed. The original audio was restored.');
            return;
        }

        audio.volume = video.volume;
        audio.muted = state.playerMuted;
        audio.playbackRate = video.playbackRate;

        if (video.paused || video.ended) {
            audio.pause();
            return;
        }

        const boundedTarget = getSecondaryTargetTime(video, audio);
        if (boundedTarget === null) {
            audio.pause();
            return;
        }

        if (force || Math.abs(audio.currentTime - boundedTarget) > 0.3) {
            try {
                audio.currentTime = Math.max(0, boundedTarget);
            } catch (error) {
                return;
            }
        }

        audio.play().catch(function () {
            failSecondaryAudio('The separate audio stream stopped. The original audio was restored.');
        });
        updateCustomMuteButtons();
    }

    function applyDelayToPlayer() {
        const video = state.video;
        if (!video) {
            return;
        }

        if (state.delayMs < 0) {
            setGraphDelay(0);
            if (!enterSecondaryAudio()) {
                state.delayMs = 0;
            }
            return;
        }

        exitSecondaryAudio();
        if (state.delayMs > 0) {
            if (!setGraphDelay(state.delayMs)) {
                state.delayMs = 0;
            }
        } else if (state.graph) {
            setGraphDelay(0);
        }
    }

    function onVideoEvent(event) {
        if (event.type === 'volumechange' && state.customAudio && state.video && state.secondaryAudio) {
            state.secondaryAudio.volume = state.video.volume;
            state.secondaryAudio.muted = state.playerMuted;
            if (!state.video.muted) {
                state.video.muted = true;
            }
        }

        if (event.type === 'play' || event.type === 'canplay' || event.type === 'loadedmetadata') {
            if (state.graph && state.delayMs > 0) {
                resumeAudioGraph(state.graph);
            }
            if (event.type === 'loadedmetadata' && !state.currentTrack) {
                primeTrack();
            }
        }

        if (state.secondaryPending) {
            activateSecondaryAudio();
        } else if (state.customAudio) {
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
        closeAudioGraph();
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

        const muteButton = target.closest('.buttonMute');
        if (muteButton && state.customAudio && state.secondaryAudio) {
            event.preventDefault();
            event.stopImmediatePropagation();
            state.playerMuted = !state.playerMuted;
            state.secondaryAudio.muted = state.playerMuted;
            updateCustomMuteButtons(muteButton);
            return;
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

    function renderDialog(preserveNumberValue) {
        if (!state.dialog) {
            return;
        }

        const delay = state.delayMs;
        state.dialog.range.value = String(delay);
        if (!preserveNumberValue) {
            state.dialog.number.value = String(delay);
        }
        state.dialog.value.textContent = formatDelay(delay);
        state.dialog.track.textContent = state.currentTrack?.label || 'Selected audio track';
        const lockable = isSeasonLockable();
        state.dialog.season.textContent = lockable
            ? `Season ${state.seasonNumber}`
            : 'Current film';
        state.dialog.lock.disabled = !lockable;
        state.dialog.lock.setAttribute('aria-disabled', String(!lockable));
        const locked = isLocked();
        const label = state.dialog.lock.querySelector('.audio-delay-lock-label');
        if (label) {
            label.textContent = !lockable
                ? 'Season lock unavailable'
                : locked ? 'Unlock for this season' : 'Lock for this season';
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

        const backdrop = document.createElement('div');
        backdrop.className = 'dialogBackdrop dialogBackdropOpened audio-delay-backdrop';

        const overlay = document.createElement('div');
        overlay.className = 'dialogContainer audio-delay-overlay';
        overlay.innerHTML = `
            <div class="focuscontainer dialog opened formDialog audio-delay-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-delay-title">
                <div class="formDialogHeader">
                    <h3 id="audio-delay-title" class="formDialogHeaderTitle">Audio Delay</h3>
                    <button is="paper-icon-button-light" type="button" class="paper-icon-button-light audio-delay-close" title="Close" aria-label="Close">
                        <span class="material-icons">close</span>
                    </button>
                </div>
                <div class="formDialogContent smoothScrollY">
                    <div class="dialogContentInner">
                        <div class="audio-delay-track" aria-live="polite"></div>
                        <div class="fieldDescription audio-delay-season"></div>
                        <div class="inlineForm audio-delay-controls">
                            <div class="inputContainer audio-delay-slider-field">
                                <div class="sliderContainer-settings">
                                    <label class="sliderLabel" for="audio-delay-range">Delay</label>
                                    <div class="audio-delay-range-wrap">
                                        <input is="emby-slider" class="emby-slider audio-delay-range" id="audio-delay-range" type="range" min="${MIN_DELAY_MS}" max="${MAX_DELAY_MS}" step="10" aria-label="Audio delay">
                                    </div>
                                </div>
                            </div>
                            <div class="inputContainer audio-delay-number-field">
                                <label class="inputLabel" for="audio-delay-number">Milliseconds</label>
                                <input is="emby-input" class="emby-input audio-delay-number" id="audio-delay-number" type="number" min="${MIN_DELAY_MS}" max="${MAX_DELAY_MS}" step="1" aria-label="Audio delay in milliseconds">
                            </div>
                        </div>
                        <div class="fieldDescription audio-delay-value" aria-live="polite"></div>
                        <div class="audio-delay-status fieldDescription" role="status" aria-live="polite"></div>
                    </div>
                </div>
                <div class="formDialogFooter formDialogFooter-flex">
                    <button is="emby-button" type="button" class="raised button-cancel formDialogFooterItem formDialogFooterItem-autosize audio-delay-reset"><span class="material-icons">restart_alt</span><span>Reset</span></button>
                    <button is="emby-button" type="button" class="raised button-submit formDialogFooterItem formDialogFooterItem-autosize audio-delay-lock"><span class="material-icons">lock</span><span class="audio-delay-lock-label">Lock for this season</span></button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        document.body.appendChild(overlay);
        const bodyWasNoScroll = document.body.classList.contains('noScroll');
        document.body.classList.add('noScroll');

        const dialog = overlay.querySelector('.audio-delay-dialog');
        state.dialog = {
            overlay,
            backdrop,
            bodyWasNoScroll,
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
            setDelayFromNumberInput(state.dialog.number.value);
        });
        state.dialog.number.addEventListener('change', function () {
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

        const dialog = state.dialog;
        state.dialog = null;
        dialog.overlay.remove();
        dialog.backdrop.remove();
        if (!dialog.bodyWasNoScroll) {
            document.body.classList.remove('noScroll');
        }
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .audio-delay-overlay {
                pointer-events: auto;
            }
            .audio-delay-backdrop {
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
                width: min(34em, calc(100vw - 2em));
                min-height: 0;
                max-height: calc(100vh - 2em);
                overflow: hidden;
            }
            .audio-delay-dialog .formDialogContent {
                min-height: 0;
                overflow-y: auto;
                overscroll-behavior: contain;
            }
            .audio-delay-dialog .dialogContentInner {
                padding-top: .75em;
                padding-bottom: .75em;
            }
            .audio-delay-track {
                overflow-wrap: anywhere;
                font-weight: 500;
            }
            .audio-delay-season {
                margin-top: .25em;
            }
            .audio-delay-controls {
                margin-top: .75em;
            }
            .audio-delay-controls .inputContainer {
                min-width: 0;
            }
            .audio-delay-slider-field .sliderContainer-settings {
                margin-bottom: 0;
            }
            .audio-delay-range-wrap {
                width: 100%;
                min-width: 0;
            }
            .audio-delay-range-wrap .mdl-slider-container {
                width: 100%;
            }
            .audio-delay-number {
                width: 100%;
                min-width: 0;
            }
            .audio-delay-value {
                margin-top: -.9em;
                font-variant-numeric: tabular-nums;
            }
            .audio-delay-status {
                margin-top: .25em;
            }
            .audio-delay-status:empty {
                display: none;
            }
            @media (max-width: 34em) {
                .audio-delay-controls {
                    display: block;
                }
                .audio-delay-controls .inputContainer {
                    margin-left: 0;
                    margin-right: 0;
                }
                .audio-delay-number-field {
                    margin-top: .5em;
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
            if (state.secondaryPending) {
                activateSecondaryAudio();
            } else if (state.customAudio) {
                syncSecondaryAudio(false);
            }
        }, 100);
        scan();
        window.setInterval(scan, 500);
    }

    start();
}());
