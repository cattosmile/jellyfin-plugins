(function () {
    'use strict';

    const CARD_CLASS = 'disk-space-indicator-card';
    const STYLE_ID = 'disk-space-indicator-style';
    const REFRESH_INTERVAL_MS = 60 * 1000;
    const RETRY_DELAY_MS = 2 * 1000;
    const REQUEST_TIMEOUT_MS = 10 * 1000;
    const SCAN_POLL_INTERVAL_MS = 2 * 1000;
    let lastSnapshot;
    let refreshTimer;
    let drawerObserver;
    let ensureCardFrame;
    let started = false;
    let retryTimer;
    let requestInFlight = false;
    let scanPollTimer;
    let scanStatusRequestInFlight = false;
    let scanStartRequestInFlight = false;

    function formatBytes(bytes) {
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
        let value = Number(bytes);
        let unit = 0;

        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }

        const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
        return `${value.toFixed(digits)} ${units[unit]}`;
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${CARD_CLASS} {
                position: absolute;
                right: 0;
                bottom: 0;
                left: 0;
                z-index: 2;
                box-sizing: border-box;
                margin: 0;
                padding: 1em 1.25em 1.25em;
                color: rgba(255, 255, 255, .88);
                background: #101010;
                font-size: .9em;
                box-shadow: 0 -0.35em 1em rgba(0, 0, 0, .18);
            }
            .disk-space-indicator-drawer {
                position: relative;
            }
            .${CARD_CLASS}__heading {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: .5em;
                font-weight: 500;
            }
            .${CARD_CLASS}__refresh {
                cursor: pointer;
                border: 0;
                padding: .1em .25em;
                color: rgba(255, 255, 255, .58);
                background: transparent;
                font-size: 1em;
            }
            .${CARD_CLASS}__refresh:hover,
            .${CARD_CLASS}__refresh:focus {
                color: #fff;
            }
            .${CARD_CLASS}__refresh--spinning {
                animation: disk-space-indicator-refresh 450ms ease-in-out;
            }
            .${CARD_CLASS}__track {
                height: .3em;
                margin-top: .8em;
                overflow: hidden;
                border-radius: .25em;
                background: #252528;
            }
            .${CARD_CLASS}__fill {
                width: 0;
                height: 100%;
                border-radius: inherit;
                background: #00a4dc;
                transition: width 180ms ease-out;
            }
            .${CARD_CLASS}__label {
                margin-top: .55em;
                color: rgba(255, 255, 255, .62);
                font-size: .82em;
                line-height: 1.35;
            }
            .${CARD_CLASS}__scan {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                position: relative;
                box-sizing: border-box;
                -webkit-tap-highlight-color: transparent;
                outline: 0;
                margin: 1em 0 0;
                width: 100%;
                cursor: pointer;
                user-select: none;
                vertical-align: middle;
                appearance: none;
                text-decoration: none;
                font-family: "Noto Sans", sans-serif;
                font-size: .875rem;
                line-height: 1.75;
                text-transform: none;
                min-width: 64px;
                padding: 6px 16px;
                border: 0;
                border-radius: 4px;
                color: rgba(0, 0, 0, .87);
                background-color: #00a4dc;
                box-shadow: 0 3px 1px -2px rgba(0, 0, 0, .2), 0 2px 2px 0 rgba(0, 0, 0, .14), 0 1px 5px 0 rgba(0, 0, 0, .12);
                font-weight: 700;
                transition: background-color 250ms cubic-bezier(.4, 0, .2, 1), box-shadow 250ms cubic-bezier(.4, 0, .2, 1), border-color 250ms cubic-bezier(.4, 0, .2, 1);
            }
            .${CARD_CLASS}__scan:hover {
                text-decoration: none;
                box-shadow: 0 2px 4px -1px rgba(0, 0, 0, .2), 0 4px 5px 0 rgba(0, 0, 0, .14), 0 1px 10px 0 rgba(0, 0, 0, .12);
            }
            .${CARD_CLASS}__scan:active {
                box-shadow: 0 5px 5px -3px rgba(0, 0, 0, .2), 0 8px 10px 1px rgba(0, 0, 0, .14), 0 3px 14px 2px rgba(0, 0, 0, .12);
            }
            .${CARD_CLASS}__scan:focus-visible {
                box-shadow: 0 3px 1px -2px rgba(0, 0, 0, .2), 0 2px 2px 0 rgba(0, 0, 0, .14), 0 1px 5px 0 rgba(0, 0, 0, .12);
            }
            .${CARD_CLASS}__scan:disabled {
                pointer-events: none;
                cursor: default;
                color: rgba(0, 0, 0, .26);
                box-shadow: none;
                background-color: rgba(0, 0, 0, .12);
            }
            .${CARD_CLASS}__scan-progress {
                margin-top: .8em;
                max-height: 4em;
                overflow: hidden;
                opacity: 1;
                transition: max-height 220ms ease, margin-top 220ms ease, opacity 180ms ease;
            }
            .${CARD_CLASS}__scan-progress--hidden {
                max-height: 0;
                margin-top: 0;
                opacity: 0;
                pointer-events: none;
            }
            .${CARD_CLASS}__scan-track {
                height: .3em;
                overflow: hidden;
                border-radius: .25em;
                background: #252528;
            }
            .${CARD_CLASS}__scan-fill {
                width: 0;
                height: 100%;
                border-radius: inherit;
                background: #00a4dc;
                transition: width 180ms ease-out;
            }
            .${CARD_CLASS}__scan-fill--indeterminate {
                width: 45%;
                animation: disk-space-indicator-scan 1.4s ease-in-out infinite alternate;
            }
            .${CARD_CLASS}__scan-status {
                margin-top: .45em;
                color: rgba(255, 255, 255, .62);
                font-size: .82em;
                line-height: 1.35;
            }
            .${CARD_CLASS}__scan-status--error {
                color: #ffb4ab;
            }
            @keyframes disk-space-indicator-scan {
                from { transform: translateX(-55%); }
                to { transform: translateX(125%); }
            }
            @keyframes disk-space-indicator-refresh {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    function findDrawerContent() {
        return document.querySelector('.mainDrawer .scrollContainer') ||
            document.querySelector('.mainDrawer-scrollContainer');
    }

    function createCard() {
        const card = document.createElement('div');
        card.className = CARD_CLASS;
        card.setAttribute('role', 'status');
        card.innerHTML = `
            <div class="${CARD_CLASS}__heading">
                <span>Disk Space</span>
                <button class="${CARD_CLASS}__refresh" type="button" aria-label="Refresh disk space" title="Refresh">↻</button>
            </div>
            <div class="${CARD_CLASS}__track" aria-hidden="true"><div class="${CARD_CLASS}__fill"></div></div>
            <div class="${CARD_CLASS}__label">Loading…</div>
            <button class="${CARD_CLASS}__scan" type="button">
                <span class="${CARD_CLASS}__scan-label">Scan All Libraries</span>
            </button>
            <div class="${CARD_CLASS}__scan-progress ${CARD_CLASS}__scan-progress--hidden" aria-hidden="true">
                <div class="${CARD_CLASS}__scan-track" aria-hidden="true"><div class="${CARD_CLASS}__scan-fill"></div></div>
                <div class="${CARD_CLASS}__scan-status" role="status" aria-live="polite"></div>
            </div>
        `;
        const refreshButton = card.querySelector(`.${CARD_CLASS}__refresh`);
        refreshButton.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            refreshButton.classList.remove(`${CARD_CLASS}__refresh--spinning`);
            void refreshButton.offsetWidth;
            refreshButton.classList.add(`${CARD_CLASS}__refresh--spinning`);
            loadSnapshot();
        });
        card.querySelector(`.${CARD_CLASS}__scan`).addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            startLibraryScan();
        });
        return card;
    }

    function renderSnapshot() {
        const card = document.querySelector(`.${CARD_CLASS}`);
        if (!card || !lastSnapshot) {
            return;
        }

        const percentage = Math.max(0, Math.min(100, Number(lastSnapshot.UsedPercentage)));
        const label = card.querySelector(`.${CARD_CLASS}__label`);
        card.querySelector(`.${CARD_CLASS}__fill`).style.width = `${percentage}%`;
        label.classList.remove(`${CARD_CLASS}__label--error`);
        label.textContent =
            `${formatBytes(lastSnapshot.UsedBytes)} of ${formatBytes(lastSnapshot.TotalBytes)} used`;
        card.title = `${formatBytes(lastSnapshot.FreeBytes)} free (${(100 - percentage).toFixed(1)}%)`;
    }

    function renderError(error) {
        const card = document.querySelector(`.${CARD_CLASS}`);
        if (!card) {
            return;
        }

        const label = card.querySelector(`.${CARD_CLASS}__label`);
        // Keep the last successful value visible during a transient request
        // failure. The title still exposes the diagnostic without turning a
        // valid, slightly stale value into a red error message.
        if (lastSnapshot) {
            renderSnapshot();
        } else {
            label.textContent = 'Disk space unavailable';
        }
        card.title = error && error.message ? error.message : 'Disk space endpoint unavailable';
    }

    function renderScanStatus(status) {
        const card = document.querySelector(`.${CARD_CLASS}`);
        if (!card) {
            return;
        }

        const button = card.querySelector(`.${CARD_CLASS}__scan`);
        const buttonLabel = card.querySelector(`.${CARD_CLASS}__scan-label`);
        const progress = card.querySelector(`.${CARD_CLASS}__scan-progress`);
        const fill = card.querySelector(`.${CARD_CLASS}__scan-fill`);
        const statusLabel = card.querySelector(`.${CARD_CLASS}__scan-status`);
        const isRunning = Boolean(status && (status.IsRunning || status.isRunning));
        const state = status && (status.State || status.state);
        const message = status && (status.Message || status.message);

        button.disabled = isRunning || scanStartRequestInFlight;
        buttonLabel.textContent = isRunning ? 'Scanning…' : 'Scan All Libraries';
        statusLabel.classList.remove(`${CARD_CLASS}__scan-status--error`);

        if (!isRunning) {
            progress.classList.add(`${CARD_CLASS}__scan-progress--hidden`);
            progress.setAttribute('aria-hidden', 'true');
            fill.classList.remove(`${CARD_CLASS}__scan-fill--indeterminate`);
            fill.style.width = '0';
            statusLabel.textContent = state === 'Unavailable' ? (message || 'Library scan unavailable.') : '';
            if (state === 'Unavailable') {
                statusLabel.classList.add(`${CARD_CLASS}__scan-status--error`);
            }
            return;
        }

        progress.classList.remove(`${CARD_CLASS}__scan-progress--hidden`);
        progress.setAttribute('aria-hidden', 'false');
        const rawPercentage = status.ProgressPercentage ?? status.progressPercentage;
        const percentage = Number(rawPercentage);
        if (Number.isFinite(percentage)) {
            fill.classList.remove(`${CARD_CLASS}__scan-fill--indeterminate`);
            fill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
            statusLabel.textContent = `Scanning media library… ${percentage.toFixed(0)}%`;
        } else {
            fill.classList.add(`${CARD_CLASS}__scan-fill--indeterminate`);
            fill.style.width = '45%';
            statusLabel.textContent = message || 'Scanning media library…';
        }
    }

    function renderScanError(error) {
        const card = document.querySelector(`.${CARD_CLASS}`);
        if (!card) {
            return;
        }

        const button = card.querySelector(`.${CARD_CLASS}__scan`);
        const buttonLabel = card.querySelector(`.${CARD_CLASS}__scan-label`);
        const progress = card.querySelector(`.${CARD_CLASS}__scan-progress`);
        const fill = card.querySelector(`.${CARD_CLASS}__scan-fill`);
        const statusLabel = card.querySelector(`.${CARD_CLASS}__scan-status`);
        button.disabled = false;
        buttonLabel.textContent = 'Scan All Libraries';
        progress.classList.remove(`${CARD_CLASS}__scan-progress--hidden`);
        progress.setAttribute('aria-hidden', 'false');
        fill.classList.remove(`${CARD_CLASS}__scan-fill--indeterminate`);
        fill.style.width = '0';
        statusLabel.classList.add(`${CARD_CLASS}__scan-status--error`);
        statusLabel.textContent = error && error.message ? error.message : 'Library scan unavailable.';
    }

    function scheduleScanStatus() {
        if (scanPollTimer) {
            return;
        }

        scanPollTimer = window.setTimeout(function () {
            scanPollTimer = undefined;
            loadScanStatus();
        }, SCAN_POLL_INTERVAL_MS);
    }

    function loadScanStatus() {
        const apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.accessToken !== 'function' || !apiClient.accessToken() || scanStatusRequestInFlight) {
            return;
        }

        scanStatusRequestInFlight = true;
        Promise.resolve(apiClient.getJSON(apiClient.getUrl('AdministratorEnhancements/ScanStatus'), true)).then(function (status) {
            renderScanStatus(status);
            if (status.IsRunning || status.isRunning) {
                scheduleScanStatus();
            }
        }).catch(function (error) {
            renderScanError(error);
        }).finally(function () {
            scanStatusRequestInFlight = false;
        });
    }

    function startLibraryScan() {
        if (scanStartRequestInFlight) {
            return;
        }

        const apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.accessToken !== 'function' || !apiClient.accessToken()) {
            return;
        }

        scanStartRequestInFlight = true;
        renderScanStatus({
            IsRunning: true,
            ProgressPercentage: null,
            State: 'Queued',
            Message: 'Starting library scan…'
        });

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl('AdministratorEnhancements/ScanLibraries'),
            dataType: 'json'
        }).then(function (status) {
            renderScanStatus(status);
            scheduleScanStatus();
        }).catch(function (error) {
            renderScanError(error);
        }).finally(function () {
            scanStartRequestInFlight = false;
        });
    }

    function scheduleLoad(delay) {
        if (retryTimer) {
            return;
        }

        retryTimer = window.setTimeout(function () {
            retryTimer = undefined;
            loadSnapshot();
        }, delay);
    }

    function fetchSnapshot(apiClient) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            const timeout = window.setTimeout(function () {
                if (!settled) {
                    settled = true;
                    reject(new Error('Disk space request timed out'));
                }
            }, REQUEST_TIMEOUT_MS);

            let request;
            try {
                request = apiClient.getJSON(apiClient.getUrl('DiskSpace/Info'), true);
            } catch (error) {
                window.clearTimeout(timeout);
                reject(error);
                return;
            }

            Promise.resolve(request).then(function (snapshot) {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeout);
                resolve(snapshot);
            }, function (error) {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeout);
                reject(error);
            });
        });
    }

    function ensureCard() {
        const drawerContent = findDrawerContent();
        if (!drawerContent) {
            return;
        }

        addStyles();
        drawerContent.classList.add('disk-space-indicator-drawer');
        let card = drawerContent.querySelector(`.${CARD_CLASS}`);
        if (!card) {
            card = createCard();
            drawerContent.appendChild(card);
        }
        if (lastSnapshot) {
            renderSnapshot();
        }
        return card;
    }

    function loadSnapshot() {
        if (retryTimer) {
            window.clearTimeout(retryTimer);
            retryTimer = undefined;
        }

        ensureCard();

        if (requestInFlight) {
            return;
        }

        const apiClient = window.ApiClient;
        if (!apiClient || typeof apiClient.accessToken !== 'function') {
            scheduleLoad(500);
            return;
        }

        let accessToken;
        try {
            accessToken = apiClient.accessToken();
        } catch (error) {
            scheduleLoad(500);
            return;
        }

        if (!accessToken) {
            scheduleLoad(500);
            return;
        }

        requestInFlight = true;
        fetchSnapshot(apiClient).then(function (snapshot) {
            lastSnapshot = snapshot;
            ensureCard();
            renderSnapshot();
        }).catch(function (error) {
            renderError(error);
            scheduleLoad(RETRY_DELAY_MS);
        }).then(function () {
            requestInFlight = false;
        });
    }

    function scheduleEnsureCard() {
        if (ensureCardFrame) {
            return;
        }

        const schedule = window.requestAnimationFrame || function (callback) {
            return window.setTimeout(callback, 0);
        };
        ensureCardFrame = schedule(function () {
            ensureCardFrame = undefined;
            ensureCard();
        });
    }

    function observeDrawer() {
        if (drawerObserver || !document.body || typeof MutationObserver !== 'function') {
            return;
        }

        drawerObserver = new MutationObserver(scheduleEnsureCard);
        drawerObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function start() {
        observeDrawer();

        if (started) {
            return;
        }

        const drawer = findDrawerContent();
        if (!drawer) {
            window.setTimeout(start, 100);
            return;
        }

        started = true;
        ensureCard();
        loadSnapshot();
        loadScanStatus();
        refreshTimer = window.setInterval(loadSnapshot, REFRESH_INTERVAL_MS);
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    }
}());
