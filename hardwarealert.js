"use strict";
module.exports.hardwarealert = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.fs = require('fs');
    obj.path = require('path');
    obj.https = require('https');
    obj.VIEWS = __dirname + '/views/';

    var pg = null;
    var pgPool = null;
    var dbReady = false;

    try { pg = require('pg'); } catch (e) {
        try { pg = require(obj.path.join(obj.meshServer.parentpath, 'node_modules/pg')); } catch (e2) {
            try { pg = require('/opt/meshcentral/meshcentral/node_modules/pg'); } catch (e3) {
                console.log('Hardware Alert: FATAL - pg module not found.');
            }
        }
    }

    var DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
    var lastAlertTimes = {};
    var cachedSettings = null;

    obj.exports = ['onDeviceRefreshEnd'];

    obj.server_startup = function () {
        obj.initPgPool();
        obj.initDb();
    };

    obj.initPgPool = function () {
        if (!pg) return;
        var pgConfig = obj.meshServer.config.settings.postgres;
        if (!pgConfig) {
            console.log('Hardware Alert: No PostgreSQL config found.');
            return;
        }
        pgPool = new pg.Pool({
            host: pgConfig.host || 'localhost',
            port: pgConfig.port || 5432,
            user: pgConfig.user || 'meshcentral',
            password: pgConfig.password || '',
            database: pgConfig.database || 'meshcentral'
        });
        pgPool.on('error', function (err) {
            console.log('Hardware Alert: PG pool error:', err.message);
        });
        console.log('Hardware Alert: PG pool created for ' + pgConfig.host + ':' + pgConfig.port + '/' + pgConfig.database);
    };

    obj.initDb = function () {
        if (!pgPool) {
            console.log('Hardware Alert: No PG pool, skipping DB init.');
            return;
        }
        var statements = [
            'CREATE TABLE IF NOT EXISTS hardware_history (id SERIAL PRIMARY KEY, node_id VARCHAR(64) NOT NULL, node_name VARCHAR(256), snapshot_time TIMESTAMP NOT NULL DEFAULT NOW(), hardware_data JSONB, change_type VARCHAR(32) NOT NULL, change_category VARCHAR(64) NOT NULL, change_detail JSONB, acknowledged BOOLEAN NOT NULL DEFAULT FALSE)',
            'CREATE INDEX IF NOT EXISTS idx_hardware_history_node_id ON hardware_history (node_id)',
            'CREATE INDEX IF NOT EXISTS idx_hardware_history_snapshot_time ON hardware_history (snapshot_time)',
            'CREATE INDEX IF NOT EXISTS idx_hardware_history_change_category ON hardware_history (change_category)',
            'CREATE INDEX IF NOT EXISTS idx_hardware_history_acknowledged ON hardware_history (acknowledged)',
            'CREATE TABLE IF NOT EXISTS hw_alert_settings (key VARCHAR(128) PRIMARY KEY, value TEXT)'
        ];
        var idx = 0;
        function runNext() {
            if (idx >= statements.length) {
                dbReady = true;
                console.log('Hardware Alert: All DB tables ready.');
                return;
            }
            pgPool.query(statements[idx], [], function (err) {
                if (err) console.log('Hardware Alert: DB init error on statement ' + idx + ':', err.message);
                idx++;
                runNext();
            });
        }
        runNext();
    };

    obj.dbQuery = function (sql, params, callback) {
        if (!pgPool) { if (callback) callback(new Error('PG pool not available'), null); return; }
        pgPool.query(sql, params, function (err, result) {
            if (callback) callback(err, result);
        });
    };

    obj.getSetting = function (key, callback) {
        obj.dbQuery('SELECT value FROM hw_alert_settings WHERE key = $1', [key], function (err, result) {
            if (err || !result || !result.rows || result.rows.length === 0) { callback(null); return; }
            callback(result.rows[0].value);
        });
    };

    obj.setSetting = function (key, value, callback) {
        obj.dbQuery('INSERT INTO hw_alert_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value], function (err) {
            if (err) { console.log('Hardware Alert: Error saving setting:', err.message); if (callback) callback(false); return; }
            cachedSettings = null;
            if (callback) callback(true);
        });
    };

    obj.loadAllSettings = function (callback) {
        obj.dbQuery('SELECT key, value FROM hw_alert_settings', [], function (err, result) {
            var settings = {};
            if (!err && result && result.rows) {
                for (var i = 0; i < result.rows.length; i++) {
                    settings[result.rows[i].key] = result.rows[i].value;
                }
            }
            cachedSettings = settings;
            callback(settings);
        });
    };

    obj.getSettings = function (callback) {
        if (cachedSettings) { callback(cachedSettings); return; }
        obj.loadAllSettings(callback);
    };

    obj.getAlertCooldownMs = function (callback) {
        obj.getSetting('alert_cooldown', function (val) {
            if (val && !isNaN(parseInt(val))) {
                callback(parseInt(val) * 60 * 1000);
            } else {
                callback(DEFAULT_COOLDOWN_MS);
            }
        });
    };

    obj.detectHardwareChanges = function (previous, current) {
        var changes = [];
        var categories = ['motherboard', 'cpu', 'memory', 'disks', 'nics', 'bios', 'gpu'];
        for (var i = 0; i < categories.length; i++) {
            var cat = categories[i];
            var prevVal = previous ? previous[cat] : null;
            var curVal = current ? current[cat] : null;
            if (JSON.stringify(prevVal) !== JSON.stringify(curVal)) {
                var changeType = 'modified';
                if (!prevVal) changeType = 'added';
                else if (!curVal) changeType = 'removed';
                changes.push({
                    category: cat, type: changeType,
                    previous: prevVal, current: curVal,
                    detail: buildChangeDetail(cat, prevVal, curVal)
                });
            }
        }
        return changes;
    };

    function buildChangeDetail(category, previous, current) {
        var details = [];
        if (Array.isArray(current) && Array.isArray(previous)) {
            var prevIds = previous.map(function (item) { return JSON.stringify(item); });
            var curIds = current.map(function (item) { return JSON.stringify(item); });
            for (var i = 0; i < curIds.length; i++) {
                if (prevIds.indexOf(curIds[i]) === -1) details.push({ action: 'added', item: current[i] });
            }
            for (var j = 0; j < prevIds.length; j++) {
                if (curIds.indexOf(prevIds[j]) === -1) details.push({ action: 'removed', item: previous[j] });
            }
        } else if (previous && current) {
            var prevKeys = Object.keys(previous);
            var curKeys = Object.keys(current);
            var allKeys = prevKeys.concat(curKeys.filter(function (k) { return prevKeys.indexOf(k) === -1; }));
            for (var k = 0; k < allKeys.length; k++) {
                var key = allKeys[k];
                if (previous[key] !== current[key]) details.push({ field: key, from: previous[key], to: current[key] });
            }
        } else if (!previous && current) {
            details.push({ action: 'added', item: current });
        } else if (previous && !current) {
            details.push({ action: 'removed', item: previous });
        }
        return details;
    }

    obj.saveHardwareHistory = function (nodeId, nodeName, hardwareData, changes) {
        for (var i = 0; i < changes.length; i++) {
            var change = changes[i];
            obj.dbQuery(
                'INSERT INTO hardware_history (node_id, node_name, hardware_data, change_type, change_category, change_detail) VALUES ($1, $2, $3, $4, $5, $6)',
                [nodeId, nodeName || '', JSON.stringify(hardwareData), change.type, change.category, JSON.stringify(change.detail || {})],
                function (err) { if (err) console.log('Hardware Alert: Error saving history:', err.message); }
            );
        }
    };

    obj.sendDingTalkWebhook = function (nodeName, changes) {
        obj.getSetting('dingtalk_token', function (token) {
            if (!token) { console.log('Hardware Alert: DingTalk token not configured.'); return; }
            obj.getAlertCooldownMs(function (cooldownMs) {
                var cooldownKey = nodeName + '_' + changes.map(function (c) { return c.category; }).join(',');
                var now = Date.now();
                if (lastAlertTimes[cooldownKey] && (now - lastAlertTimes[cooldownKey]) < cooldownMs) return;
                lastAlertTimes[cooldownKey] = now;

                var changeText = changes.map(function (c) {
                    return '- **' + c.category + '** (' + c.type + '): ' + (c.detail && c.detail.length > 0 ? c.detail.map(function (d) {
                        if (d.field) return d.field + ': ' + d.from + ' \u2192 ' + d.to;
                        return d.action + ': ' + JSON.stringify(d.item);
                    }).join('; ') : 'see detail');
                }).join('\n');

                var postData = JSON.stringify({
                    msgtype: 'markdown',
                    markdown: {
                        title: '\u26A0\uFE0F \u786C\u4EF6\u53D8\u66F4\u544A\u8B66',
                        text: '### \u26A0\uFE0F \u786C\u4EF6\u53D8\u66F4\u544A\u8B66\n\n**\u8BBE\u5907**\uFF1A' + (nodeName || 'Unknown') + '\n\n**\u53D8\u66F4\u5185\u5BB9**\uFF1A\n' + changeText + '\n\n**\u65F6\u95F4**\uFF1A' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                    }
                });

                var req = obj.https.request({
                    hostname: 'oapi.dingtalk.com', port: 443,
                    path: '/robot/send?access_token=' + token, method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
                }, function (res) {
                    var body = '';
                    res.on('data', function (chunk) { body += chunk; });
                    res.on('end', function () {
                        try { var r = JSON.parse(body); if (r.errcode !== 0) console.log('Hardware Alert: DingTalk error:', r.errmsg); } catch (e) {}
                    });
                });
                req.on('error', function (e) { console.log('Hardware Alert: DingTalk request error:', e.message); });
                req.write(postData);
                req.end();
            });
        });
    };

    obj.getLastHardwareSnapshot = function (nodeId, callback) {
        obj.dbQuery('SELECT hardware_data FROM hardware_history WHERE node_id = $1 ORDER BY snapshot_time DESC LIMIT 1', [nodeId], function (err, result) {
            if (err || !result || !result.rows || result.rows.length === 0) { callback(null); return; }
            try {
                var data = typeof result.rows[0].hardware_data === 'string' ? JSON.parse(result.rows[0].hardware_data) : result.rows[0].hardware_data;
                callback(data);
            } catch (e) { callback(null); }
        });
    };

    obj.hook_agentCoreIsStable = function (node) {
        if (!node || !node.hardware) return;
        var nodeId = node._id;
        var nodeName = node.name;
        obj.getLastHardwareSnapshot(nodeId, function (previous) {
            var currentHardware = {};
            try {
                var hw = node.hardware;
                if (hw.bios) currentHardware.bios = hw.bios;
                if (hw.baseboard) currentHardware.motherboard = hw.baseboard;
                if (hw.cpu) currentHardware.cpu = hw.cpu;
                if (hw.mem) currentHardware.memory = hw.mem;
                if (hw.ident) currentHardware.disks = hw.ident;
            } catch (e) { return; }
            if (Object.keys(currentHardware).length === 0) return;
            var changes = obj.detectHardwareChanges(previous, currentHardware);
            if (changes.length > 0) {
                obj.saveHardwareHistory(nodeId, nodeName, currentHardware, changes);
                obj.sendDingTalkWebhook(nodeName, changes);
            }
        });
    };

    obj.onDeviceRefreshEnd = function (nodeid, panel, refresh, event) {
        pluginHandler.registerPluginTab({
            tabId: 'pluginHardwareAlert',
            tabTitle: '\u786C\u4EF6\u53D8\u66F4\u5386\u53F2',
            tabOrder: 90,
            source: 'plugin:hardwarealert'
        });

        var tabContent = '<div style="padding:16px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
            '<div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">' +
            '<h3 style="margin:0;color:#1e293b;">\u26A0\uFE0F \u786C\u4EF6\u53D8\u66F4\u5386\u53F2</h3>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
            '<select id="hwCategoryFilter" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="">\u6240\u6709\u7C7B\u522B</option>' +
            '<option value="motherboard">\u4E3B\u677F</option><option value="cpu">CPU</option><option value="memory">\u5185\u5B58</option>' +
            '<option value="disks">\u78C1\u76D8</option><option value="nics">\u7F51\u5361</option><option value="bios">BIOS</option><option value="gpu">\u663E\u5361</option>' +
            '</select>' +
            '<input id="hwSearchInput" type="text" placeholder="\u641C\u7D22\u53D8\u66F4..." style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;flex:1;" />' +
            '</div></div>' +
            '<div id="hwHistoryTimeline" style="max-height:500px;overflow-y:auto;">' +
            '<p style="color:#64748b;text-align:center;padding:32px;">\u786C\u4EF6\u53D8\u66F4\u8BB0\u5F55\u5C06\u5728\u8BBE\u5907\u786C\u4EF6\u53D1\u751F\u53D8\u66F4\u540E\u81EA\u52A8\u663E\u793A\u3002</p>' +
            '</div></div>';

        QA('pluginHardwareAlert', tabContent);
    };

    obj.handleAdminReq = function (req, res, user) {
        if (req.query.user == 1) {
            obj.getSettings(function (settings) {
                var vars = {
                    dingtalkToken: settings.dingtalk_token || '',
                    alertCooldown: settings.alert_cooldown || '30',
                    pluginVersion: '1.2.0'
                };
                res.render(obj.VIEWS + 'hardwarealert', vars);
            });
        }
    };

    obj.serveraction = function (command, myparent, grandparent) {
        if (command.plugin != 'hardwarealert') return;

        var sessionid = null;
        try { sessionid = myparent.ws.sessionId; } catch (e) {}

        switch (command.pluginaction) {
            case 'getAlerts':
                obj.handleGetAlerts(command, myparent, sessionid);
                break;
            case 'getSettings':
                obj.handleGetSettings(command, myparent, sessionid);
                break;
            case 'saveSettings':
                obj.handleSaveSettings(command, myparent, sessionid);
                break;
            case 'acknowledgeAlert':
                obj.handleAcknowledgeAlert(command, myparent, sessionid);
                break;
            case 'getStats':
                obj.handleGetStats(command, myparent, sessionid);
                break;
            default:
                break;
        }
    };

    function sendToSession(sessionid, response) {
        if (sessionid && obj.meshServer.webserver.wssessions2 && obj.meshServer.webserver.wssessions2[sessionid]) {
            try {
                obj.meshServer.webserver.wssessions2[sessionid].send(JSON.stringify(response));
            } catch (e) {
                console.log('Hardware Alert: Error sending to session:', e);
            }
        }
    }

    obj.handleGetAlerts = function (command, myparent, sessionid) {
        var limit = parseInt(command.limit) || 50;
        var offset = parseInt(command.offset) || 0;
        var category = command.category || '';
        var acknowledged = command.acknowledged;

        var whereClauses = [];
        var params = [];
        var paramIdx = 1;

        if (category) {
            whereClauses.push('change_category = $' + paramIdx);
            params.push(category);
            paramIdx++;
        }
        if (acknowledged !== undefined && acknowledged !== '') {
            whereClauses.push('acknowledged = $' + paramIdx);
            params.push(acknowledged === 'true' || acknowledged === true);
            paramIdx++;
        }

        var whereStr = whereClauses.length > 0 ? ' WHERE ' + whereClauses.join(' AND ') : '';

        var countSql = 'SELECT COUNT(*) as total FROM hardware_history' + whereStr;
        var dataSql = 'SELECT id, node_id, node_name, snapshot_time, change_type, change_category, change_detail, acknowledged FROM hardware_history' + whereStr + ' ORDER BY snapshot_time DESC LIMIT $' + paramIdx + ' OFFSET $' + (paramIdx + 1);
        params.push(limit, offset);

        obj.dbQuery(countSql, params.slice(0, -2), function (err, countResult) {
            var total = 0;
            if (!err && countResult && countResult.rows && countResult.rows.length > 0) {
                total = parseInt(countResult.rows[0].total) || 0;
            }
            obj.dbQuery(dataSql, params, function (err2, result) {
                var alerts = [];
                if (!err2 && result && result.rows) {
                    alerts = result.rows;
                }
                sendToSession(sessionid, {
                    action: 'plugin',
                    plugin: 'hardwarealert',
                    method: 'loadAlertsData',
                    success: !err2,
                    error: err2 ? err2.message : null,
                    data: { alerts: alerts, total: total, limit: limit, offset: offset }
                });
            });
        });
    };

    obj.handleGetSettings = function (command, myparent, sessionid) {
        obj.getSettings(function (settings) {
            sendToSession(sessionid, {
                action: 'plugin',
                plugin: 'hardwarealert',
                method: 'loadSettingsData',
                success: true,
                data: settings
            });
        });
    };

    obj.handleSaveSettings = function (command, myparent, sessionid) {
        var saved = 0;
        var total = 0;
        var keys = Object.keys(command.settings || {});
        if (keys.length === 0) {
            sendToSession(sessionid, {
                action: 'plugin',
                plugin: 'hardwarealert',
                method: 'saveSettingsResult',
                success: true
            });
            return;
        }
        total = keys.length;
        for (var i = 0; i < keys.length; i++) {
            (function (key) {
                obj.setSetting(key, command.settings[key], function (ok) {
                    saved++;
                    if (saved === total) {
                        sendToSession(sessionid, {
                            action: 'plugin',
                            plugin: 'hardwarealert',
                            method: 'saveSettingsResult',
                            success: true
                        });
                    }
                });
            })(keys[i]);
        }
    };

    obj.handleAcknowledgeAlert = function (command, myparent, sessionid) {
        var alertId = command.alertId;
        if (!alertId) {
            sendToSession(sessionid, {
                action: 'plugin',
                plugin: 'hardwarealert',
                method: 'acknowledgeResult',
                success: false,
                error: 'No alert ID provided'
            });
            return;
        }
        obj.dbQuery('UPDATE hardware_history SET acknowledged = TRUE WHERE id = $1', [alertId], function (err) {
            sendToSession(sessionid, {
                action: 'plugin',
                plugin: 'hardwarealert',
                method: 'acknowledgeResult',
                success: !err,
                error: err ? err.message : null,
                alertId: alertId
            });
        });
    };

    obj.handleGetStats = function (command, myparent, sessionid) {
        var stats = {};
        var pending = 3;
        function done() {
            pending--;
            if (pending === 0) {
                sendToSession(sessionid, {
                    action: 'plugin',
                    plugin: 'hardwarealert',
                    method: 'loadStatsData',
                    success: true,
                    data: stats
                });
            }
        }
        obj.dbQuery('SELECT COUNT(*) as total FROM hardware_history', [], function (err, result) {
            stats.totalAlerts = (!err && result && result.rows) ? parseInt(result.rows[0].total) || 0 : 0;
            done();
        });
        obj.dbQuery('SELECT COUNT(*) as total FROM hardware_history WHERE acknowledged = FALSE', [], function (err, result) {
            stats.unacknowledged = (!err && result && result.rows) ? parseInt(result.rows[0].total) || 0 : 0;
            done();
        });
        obj.dbQuery('SELECT COUNT(DISTINCT node_id) as total FROM hardware_history', [], function (err, result) {
            stats.affectedDevices = (!err && result && result.rows) ? parseInt(result.rows[0].total) || 0 : 0;
            done();
        });
    };

    return obj;
};
