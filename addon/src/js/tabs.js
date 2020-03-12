(function() {
    'use strict';

    async function createNative({url, active, pinned, title, index, windowId, isInReaderMode, openInReaderMode, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, groupId, favIconUrl, thumbnail}) {
        let tab = {};

        if (utils.isUrlAllowToCreate(url)) {
            tab.url = url;
        }

        tab.active = !!active;

        if (pinned) {
            tab.pinned = true;
        }

        if (!tab.active && !tab.pinned && tab.url && !utils.isUrlEmpty(tab.url)) {
            tab.discarded = true;
        }

        if (tab.discarded && typeof title === 'string' && title.length) {
            tab.title = title;
        }

        if (Number.isFinite(index) && index >= 0) {
            tab.index = index;
        }

        let groupWindowId = cache.getWindowId(groupId);

        if (groupWindowId) {
            windowId = groupWindowId;
        }

        if (Number.isFinite(windowId) && windowId >= 1) {
            tab.windowId = windowId;
        }

        if (Number.isFinite(openerTabId) && openerTabId >= 1) {
            tab.openerTabId = openerTabId;
        }

        if (isInReaderMode || openInReaderMode) {
            tab.openInReaderMode = true;
        }

        if (typeof cookieStoreId === 'string') {
            tab.cookieStoreId = cookieStoreId;
        }

        if (newTabContainer) {
            if (ifDifferentContainerReOpen) {
                tab.cookieStoreId = newTabContainer;
            } else {
                if (containers.isDefault(tab.cookieStoreId)) {
                    tab.cookieStoreId = newTabContainer;
                }
            }
        }

        if (tab.cookieStoreId === TEMPORARY_CONTAINER) {
            tab.cookieStoreId = await containers.createTemporaryContainer();
        } else if ('cookieStoreId' in tab) {
            tab.cookieStoreId = containers.get(tab.cookieStoreId, 'cookieStoreId');
        }

        let newTab = await browser.tabs.create(tab);

        cache.setTab(newTab);

        return cache.applySession(newTab, {groupId, favIconUrl, thumbnail});
    }

    async function create(tab, sendMessage = true) {
        let newTab = await createNative(tab);

        newTab = await cache.setTabSession(newTab);

        if (newTab.groupId && sendMessage === true) {
            BG.sendMessage({
                action: 'tabs-added',
                groupId: newTab.groupId,
                tabs: [newTab],
            });
        }

        return newTab;
    }

    async function createUrlOnce(url, windowId) {
        let [tab] = await get(windowId, null, null, {url});

        if (tab) {
            return setActive(tab.id);
        } else {
            return createNative({
                active: true,
                url: url,
                windowId: windowId,
            });
        }
    }

    async function setActive(tabId = null, tabs = []) {
        let tabToActive = null;

        if (tabId) {
            tabToActive = tabs.find(tab => tab.id === tabId) || {
                id: tabId,
            };
        } else if (tabs.length) { // find lastAccessed tab
            let maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));

            tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
        }

        if (tabToActive) {
            tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

            await browser.tabs.update(tabToActive.id, {
                active: true,
            });
        }

        return tabToActive;
    }

    async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
        let [activeTab] = await get(windowId, null, null, {
            active: true,
        });

        return activeTab;
    }

    async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null) {
        let tabs = await get(windowId, false, false, {
            highlighted: true,
        });

        if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
            tabs.push(clickedTab);

            if (2 === tabs.length) {
                tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
            }
        }

        return tabs.map(utils.keyId);
    }

    async function get(windowId = browser.windows.WINDOW_ID_CURRENT, pinned = false, hidden = false, otherProps = {}) {
        let query = {
            windowId,
            pinned,
            hidden,
            windowType: browser.windows.WindowType.NORMAL,
            ...otherProps,
        };

        for (let key in query) {
            if (null === query[key]) {
                delete query[key];
            }
        }

        let tabs = await browser.tabs.query(query);

        tabs = tabs.filter(cache.filterRemovedTab).map(utils.normalizeTabUrl);

        return query.pinned ? tabs : Promise.all(tabs.map(cache.loadTabSession));
    }

    async function getOne(id) {
        let tab = await browser.tabs.get(id);

        return utils.normalizeTabUrl(tab);
    }

    async function getList(tabIds, withSession = true) {
        let tabs = await Promise.all(tabIds.map(getOne));

        return withSession ? Promise.all(tabs.map(cache.loadTabSession)) : tabs;
    }

    async function setMute(tabs, muted) {
        return Promise.all(
            tabs
            .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
            .map(tab => browser.tabs.update(tab.id, {muted}))
        );
    }

    async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
        let pinnedTabs = await get(windowId, true, null);

        if (pinnedTabs.length) {
            if (!pinnedTabs.some(tab => tab.active)) {
                await setActive(utils.getLastActiveTab(pinnedTabs).id);
            }
        } else {
            return createNative({
                url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
                pinned: createPinnedTab,
                active: true,
                windowId: windowId,
            });
        }
    }

    async function add(groupId, cookieStoreId, url, title) {
        let [group] = await Groups.load(groupId),
            [tab] = await BG.createTabsSafe([{
                url,
                title,
                cookieStoreId,
                ...Groups.getNewTabParams(group),
            }], {
                withRemoveEvents: false,
            });

        return tab;
    }

    // tabIds integer or integer array
    async function remove(tabIds) {
        return browser.tabs.remove(tabIds);
    }

    async function updateThumbnail(tabId, force) {
        if (!BG.getOptions('showTabsWithThumbnailsInManageGroups')) {
            return;
        }

        let tab = null;

        try {
            tab = await getOne(tabId);
        } catch (e) {
            return;
        }

        if (!utils.isTabLoaded(tab)) {
            return;
        }

        if (!force && cache.getTabSession(tab.id, 'thumbnail')) {
            return;
        }

        if (tab.discarded) {
            reload([tab.id]);
            return;
        }

        let thumbnail = null;

        try {
            let thumbnailBase64 = await browser.tabs.captureTab(tab.id, {
                format: browser.extensionTypes.ImageFormat.JPEG,
                quality: 25,
            });

            thumbnail = await new Promise(function(resolve, reject) {
                let img = new Image();

                img.onload = function() {
                    resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
                };

                img.onerror = img.onabort = reject;

                img.src = thumbnailBase64;
            });
        } catch (e) {}

        cache.setTabThumbnail(tab.id, thumbnail);

        BG.sendMessage({
            action: 'thumbnail-updated',
            tabId: tab.id,
            thumbnail: thumbnail,
        });
    }

    async function move(tabIds, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
        tabIds = tabIds.slice();

        console.info('moveTabs', {groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving, tabIds});

        BG.addExcludeTabsIds(tabIds);

        let showPinnedMessage = false,
            tabsCantHide = [],
            groupWindowId = cache.getWindowId(groupId),
            windowId = groupWindowId,
            [group, groups] = await Groups.load(groupId, true),
            activeTabs = [];

        if (!windowId) {
            windowId = group.tabs.length ? group.tabs[0].windowId : await Windows.getLastFocusedNormalWindow();
        }

        let tabs = await getList(tabIds);

        tabs = tabs.filter(function(tab) {
            if (tab.pinned) {
                showPinnedMessage = true;
                return false;
            }

            if (utils.isTabCanNotBeHidden(tab)) {
                let tabTitle = utils.getTabTitle(tab, false, 20);

                if (!tabsCantHide.includes(tabTitle)) {
                    tabsCantHide.push(tabTitle);
                }

                return false;
            }

            if (tab.active && tab.groupId !== groupId) {
                activeTabs.push(tab);
            }

            return true;
        });

        if (tabs.length) {
            await Promise.all(activeTabs.map(async function(activeTab) {
                let winGroupId = cache.getWindowGroup(activeTab.windowId),
                    tabsToActive = [];

                if (winGroupId) {
                    tabsToActive = groups.find(gr => gr.id === winGroupId).tabs;
                } else {
                    tabsToActive = await get(activeTab.windowId);
                }

                tabsToActive = tabsToActive.filter(tab => !tabs.some(t => t.id === tab.id));

                if (tabsToActive.length) {
                    await setActive(undefined, tabsToActive);
                } else if (winGroupId !== groupId) {
                    await createTempActiveTab(activeTab.windowId, false);
                }
            }));

            if (group.newTabContainer) {
                let tabsIdsToRemove = [],
                    newTabParams = Groups.getNewTabParams(group);

                tabs = await Promise.all(tabs.map(function(tab) {
                    if (
                        tab.cookieStoreId === group.newTabContainer ||
                        containers.isTemporary(tab.cookieStoreId) ||
                        tab.url.startsWith('moz-extension') ||
                        (tab.url.startsWith('about:') && !utils.isUrlEmpty(tab.url)) ||
                        (!group.ifDifferentContainerReOpen && !containers.isDefault(tab.cookieStoreId))
                    ) {
                        return tab;
                    }

                    tabsIdsToRemove.push(tab.id);

                    return create({
                        ...tab,
                        windowId,
                        ...newTabParams,
                    });
                }));

                if (tabsIdsToRemove.length) {
                    let tabIdsToExclude = [];

                    tabs.forEach(function({id}) {
                        if (!tabIds.includes(id)) {
                            tabIds.push(id);
                            tabIdsToExclude.push(id);
                        }
                    });

                    BG.addExcludeTabsIds(tabIdsToExclude);

                    await remove(tabsIdsToRemove);
                }
            }

            tabs = await moveNative(tabs, {
                index: newTabIndex,
                windowId,
            });

            if (groupWindowId) {
                let tabsToShow = tabs.filter(tab => tab.hidden);

                if (tabsToShow.length) {
                    await browser.tabs.show(tabsToShow.map(utils.keyId));
                }
            } else {
                let tabsToHide = tabs.filter(tab => !tab.hidden);

                if (tabsToHide.length) {
                    await browser.tabs.hide(tabsToHide.map(utils.keyId));
                }
            }

            await Promise.all(tabs.map(tab => cache.setTabGroup(tab.id, groupId)));

            BG.removeExcludeTabsIds(tabIds);

            BG.sendMessage({
                action: 'groups-updated',
            });
        } else {
            BG.removeExcludeTabsIds(tabs.map(utils.keyId));
        }

        if (showPinnedMessage) {
            utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
        }

        if (tabsCantHide.length) {
            utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', tabsCantHide.join(', ')));
        }

        if (!tabs.length) {
            return [];
        }

        let [firstTab] = tabs;

        if (showTabAfterMoving) {
            await BG.applyGroup(windowId, groupId, firstTab.id);
            showNotificationAfterMoveTab = false;
        }

        if (!showNotificationAfterMoveTab || !BG.getOptions('showNotificationAfterMoveTab')) {
            return tabs;
        }

        let message = '',
            iconUrl = null;

        if (tabs.length > 1) {
            message = browser.i18n.getMessage('moveMultipleTabsToGroupMessage', tabs.length);
            iconUrl = utils.getGroupIconUrl(group);
        } else {
            let tabTitle = utils.getTabTitle(firstTab, false, 50);
            message = browser.i18n.getMessage('moveTabToGroupMessage', [group.title, tabTitle]);
            firstTab = utils.normalizeTabFavIcon(firstTab);
            iconUrl = firstTab.favIconUrl;
        }

        utils.notify(message, undefined, undefined, iconUrl, async function(groupId, tabId) {
            let [group] = await Groups.load(groupId),
                tab = await getOne(tabId).catch(noop);

            if (group && tab) {
                let winId = cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

                BG.applyGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, firstTab.id));

        return tabs;
    }

    async function moveNative(tabs, options = {}) {
        console.log('tabs before moving', tabs);

        // fix bug "Error: An unexpected error occurred"
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1595583
        let tabsToReload = tabs.filter(tab => tab.url && tab.discarded && !utils.isUrlEmpty(tab.url) && tab.url.startsWith('about:'));

        if (tabsToReload.length) {
            console.log('tabsToReload by bug 1595583', tabsToReload);
            await reload(tabsToReload.map(utils.keyId));
            await utils.wait(100);
        }

        let result = await browser.tabs.move(tabs.map(utils.keyId), options);
        /*
            // temp fix bug https://bugzilla.mozilla.org/show_bug.cgi?id=1580879
            // after FF 73 bug not replicated
            let tabIdsToReload = result.reduce(function(acc, tab, index) {
                if (tab.url && tab.discarded && tab.url !== tabs[index].url) {
                    tab.url = tabs[index].url;
                    acc.push(tab.id);
                }

                return acc;
            }, []);

            console.log('tabIdsToReload', tabIdsToReload);
            reload(tabIdsToReload, true);
        */
        return result;
    }

    async function discard(tabIds = []) {
        if (tabIds.length) {
            return browser.tabs.discard(tabIds).catch(noop);
        }
    }

    const extensionsWebextensionsRestrictedDomains = ['accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org', 'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com'];

    function isCanSendMessage({url}) {
        if (url === 'about:blank') {
            return true;
        }

        if (url.startsWith('moz-extension')) {
            return false;
        }

        return !extensionsWebextensionsRestrictedDomains.some(host => (new RegExp('^https?://' + host).test(url)));
    }

    function sendMessage(tabId, message) {
        message.enableDarkTheme = BG.getOptions('enableDarkTheme');

        return browser.tabs.sendMessage(tabId, message).catch(noop);
    }

    async function reload(tabIds = [], bypassCache = false) {
        await Promise.all(tabIds.map(tabId => browser.tabs.reload(tabId, {bypassCache}).catch(noop)));
    }

    function prepareForSave(tabs, includeGroupId = false, includeFavIcon = false, includeThumbnail = false) {
        return tabs.map(function({url, title, cookieStoreId, favIconUrl, isInReaderMode, openInReaderMode, groupId, thumbnail}) {
            let tab = {url, title};

            if (!containers.isDefault(cookieStoreId)) {
                tab.cookieStoreId = cookieStoreId;
            }

            if (isInReaderMode || openInReaderMode) {
                tab.openInReaderMode = true;
            }

            if (includeGroupId && groupId) {
                tab.groupId = groupId;
            }

            if (includeFavIcon && favIconUrl && favIconUrl.startsWith('data:')) {
                tab.favIconUrl = favIconUrl;
            }

            if (includeThumbnail && thumbnail) {
                tab.thumbnail = thumbnail;
            }

            return tab;
        });
    }

    window.Tabs = {
        createNative,
        create,
        createUrlOnce,
        setActive,
        getActive,
        getHighlightedIds,
        get,
        getOne,
        getList,
        setMute,
        createTempActiveTab,
        add,
        remove,
        updateThumbnail,
        move,
        moveNative,
        discard,
        isCanSendMessage,
        sendMessage,
        reload,
        prepareForSave,
    };

})();
