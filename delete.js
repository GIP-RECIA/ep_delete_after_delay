var API             = require('ep_etherpad-lite/node/db/API'),
  padManager        = require('ep_etherpad-lite/node/db/PadManager'),
  padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler'),
  settings          = require('ep_etherpad-lite/node/utils/Settings'),
  async             = require('ep_etherpad-lite/node_modules/async'),
  fs                = require('fs');

const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_delete_after_delay');

var epVersion = parseFloat(require('ep_etherpad-lite/package.json').version);
var usePromises = epVersion >= 1.8
var getHTML, getPad, listAllPads, doesPadExist;

//----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Helper: récupère les emails des admins d'un pad (pad -> group -> group.admins -> users)
function getAdminsEmailsForPad(padId, cb) {
    var storage = require('ep_mypads/storage.js');
    var PPREFIX = storage.DBPREFIX.PAD;
    var GPREFIX = storage.DBPREFIX.GROUP;
    var UPREFIX = storage.DBPREFIX.USER;

    storage.db.get(PPREFIX + padId, function(err, pad) {
        if (err || !pad) return cb(err || null, []);
        if (!pad.group) return cb(null, []);

        storage.db.get(GPREFIX + pad.group, function(err, group) {
            if (err || !group) return cb(err || null, []);
            var adminUids = group.admins || [];
            if (adminUids.length === 0) return cb(null, []);

            // Récupération séquentielle des utilisateurs
            var emails = [];
            var pending = adminUids.length;

            adminUids.forEach(function(uid) {
                storage.db.get(UPREFIX + uid, function(err, user) {
                    if (!err && user && user.email) {
                        emails.push(user.email);
                    }
                    pending--;
                    if (pending === 0) {
                        return cb(null, emails);
                    }
                });
            });
        });
    });
}
//----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

//------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Notification HTTP -> build JSON puis POST vers l'event-emitter
const NOTIF_ENDPOINT = 'http://localhost:8179/event/emit';
const NOTIF_API_KEY  = 'RmBNhP1OyLwLaCAQLPxWvvMYs9LWT8k2';
const notifBuilder = require('../../src/bin/plugins/lib/notificationBuilder.js'); // path depuis node_modules/ep_delete_after_delay

function sendServiceEventToEndpoint(targetEmail, padId, cb) {
  try {
    const event = notifBuilder.buildServiceEvent(
      'PADS',
      ['WEB'],
      'Pad bientôt expiré: ' + padId,
      'Le pad ' + padId + ' va expirer dans moins de 10 jours.',
      '/p/' + padId,
      targetEmail,
    );

    const body = JSON.stringify(event);
    const url = require('url').parse(NOTIF_ENDPOINT);
    const http = url.protocol === 'https:' ? require('https') : require('http');

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': NOTIF_API_KEY
      },
      timeout: 10000
    };

    const req = http.request(opts, function(res) {
      var resp = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk){ resp += chunk; });
      res.on('end', function(){ cb(null, { statusCode: res.statusCode, body: resp }); });
    });

    req.on('error', function(err){ cb(err); });
    req.on('timeout', function(){ req.destroy(new Error('timeout')); });

    req.write(body);
    req.end();
  } catch (e) { cb(e); }
}
//----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

var removePad = padManager.removePad

if (usePromises) {
  getHTML = callbackify2(API.getHTML)

  getPad = callbackify2(padManager.getPad)
  listAllPads = callbackify0(padManager.listAllPads)
  doesPadExist = callbackify1(padManager.doesPadExist);
} else {
  getHTML = API.getHTML

  getPad = padManager.getPad
  listAllPads = padManager.listAllPads
  doesPadExist = padManager.doesPadExist;
}


if (!fs.existsSync('deleted_pads')) {
    fs.mkdirSync('deleted_pads');
}

// Get settings
var areParamsOk = (settings.ep_delete_after_delay) ? true : false,
    delay, replaceText, loopDelay, deleteAtStart;
if (areParamsOk) {
    delay         = settings.ep_delete_after_delay.delay;
    loop          = (settings.ep_delete_after_delay.loop !== undefined) ? settings.ep_delete_after_delay.loop : true;
    loopDelay     = settings.ep_delete_after_delay.loopDelay || 3600;
    deleteAtStart = (settings.ep_delete_after_delay.deleteAtStart !== undefined) ? settings.ep_delete_after_delay.deleteAtStart : true;
    replaceText   = settings.ep_delete_after_delay.text || "The content of this pad has been deleted since it was older than the configured delay.";
    areParamsOk   = (typeof delay === 'number' && delay > 0) ? true : false;
    if (areParamsOk === false) {
        logger.error('ep_delete_after_delay.delay must be a number an not negative! Check you settings.json.');
    }
    areParamsOk = (typeof loopDelay === 'number' && loopDelay > 0) ? true : false;
    if (areParamsOk === false) {
        logger.error('ep_delete_after_delay.loopDelay must be a number an not negative! Check you settings.json.');
    }
} else {
    logger.error('You need to configure ep_delete_after_delay in your settings.json!');
}

// Recurring deletion function
var waitForIt = function() {
    setTimeout(function() {
        logger.info('New loop');
        delete_old_pads();
        waitForIt();
    }, loopDelay * 1000);
};

// Delete old pads at startup
if (deleteAtStart) {
    delete_old_pads();
}

// start the recurring deletion loop
if (loop) {
    waitForIt();
}

// deletion loop
function delete_old_pads() {
    // Deletion queue (avoids max stack size error), 2 workers
    var q = async.queue(function (pad, callback) {
        getHTML(pad.id, undefined, function(err, d) {
            if (err) {
                return callback(err);
            }
            var currentTime = (new Date).getTime();
            var a = pad.id.substr(0,1);
            if (!fs.existsSync('deleted_pads/'+a)) {
                fs.mkdirSync('deleted_pads/'+a, { recursive: true });
            }
            var path = 'deleted_pads/'+a+'/'+pad.id+'-'+currentTime+'.html';
            if (pad.id.length > 1) {
                var b = pad.id.substr(1,1);
                if (!fs.existsSync('deleted_pads/'+a+'/'+b)) {
                    fs.mkdirSync('deleted_pads/'+a+'/'+b, { recursive: true });
                }
                path = 'deleted_pads/'+a+'/'+b+'/'+pad.id+'-'+currentTime+'.html';
                if (pad.id.length > 2) {
                    var c = pad.id.substr(2,1);
                    if (!fs.existsSync('deleted_pads/'+a+'/'+b+'/'+c)) {
                        fs.mkdirSync('deleted_pads/'+a+'/'+b+'/'+c, { recursive: true });
                    }
                    path = 'deleted_pads/'+a+'/'+b+'/'+c+'/'+pad.id+'-'+currentTime+'.html';
                }
            }
            fs.writeFile(path, d.html, function(err) {
                var remove = getRemoveFun(pad)
                remove(callback);
            });
        });
    }, 2);
    // Emptyness test queue
    var p = async.queue(function(padId, callback) {
        getPad(padId, null, function(err, pad) {
            // If this is a new pad, there's nothing to do
            var head = pad.getHeadRevisionNumber();
            if (head !== null  && head !== undefined && head !== 0) {
              var getLastEdit = getLastEditFun(pad)

              getLastEdit(function(callback, timestamp) {
                    if (timestamp !== undefined && timestamp !== null) {
                        var currentTime = (new Date).getTime();
                        // Are we over delay?
                        if ((currentTime - timestamp) > (delay * 1000)) {
                            logger.debug('Pushing %s to q queue', pad.id);
                            // Remove pad
                            q.push(pad, function (err) {
                                logger.info('Pad '+pad.id+' deleted since expired (delay: '+delay+' seconds, last edition: '+timestamp+').');
                                // Create new pad with an explanation
                                getPad(padId, replaceText, function() {
                                    // Create disconnect message
                                    var msg = {
                                        type: "COLLABROOM",
                                        data: {
                                            type: "CUSTOM",
                                            payload: {
                                                authorId: null,
                                                action: "requestRECONNECT",
                                                padId: padId
                                            }
                                        }
                                    };
                                    // Send disconnect message to all clients
                                    var sessions = padMessageHandler.sessioninfos;
                                    Object.keys(sessions).forEach(function(key){
                                        var session = sessions[key];
                                        padMessageHandler.handleCustomObjectMessage(msg, false, function(){
                                            // TODO: Error handling
                                        }); // Send a message to this session
                                    });
                                });
                            });
                        } else {
                            //----------------------------------------------------------------------------------------------------------------------------------------------------------
                            if (currentTime - timestamp > (delay ) * 1000 ) {
                            logger.info('Envoie de notification pour le pad %s, il expire dans moins de 10 jours', pad.id);

                            getAdminsEmailsForPad(pad.id, function(err, emails) {
                                if (err) {
                                    logger.error('Error while fetching admins emails for pad %s: %s', pad.id, err);
                                    return;
                                }
                                if (!emails || emails.length === 0) {
                                    logger.info('No admin email found for pad %s, skipping notification', pad.id);
                                    return;
                                }

                                logger.info('Sending notification to %s for pad %s', emails.join(', '), pad.id);

                                emails.forEach(function(email) {
                                    sendServiceEventToEndpoint(email, pad.id, function(err, response) {
                                        if (err) {
                                            logger.error('Error while sending notification for pad %s to email %s: %j', pad.id, email, err.message || err);
                                        } else {
                                            logger.info('Notification sent for pad %s to email %s: %s', pad.id, email, response.statusCode);
                                        }
                                    });
                                });
                            
                            });
                        }
                    }
                    //--------------------------------------------------------------------------------------------------------------------------------------------------------------------
                }
                });
            } else {
                logger.debug('New or empty pad '+padId);
            }
            callback();
        });
    }, 1);
    listAllPads(function (err, data) {
        for (var i = 0; i < data.padIDs.length; i++) {
            var padId = data.padIDs[i];
            logger.debug('Pushing %s to p queue', padId);
            p.push(padId, function (err) { });
        }
    });
}

// Add CSS
exports.eejsBlock_styles = function (hook, context, cb) {
    context.content = context.content + '<link rel="stylesheet" type="text/css" href="../static/plugins/ep_delete_after_delay/static/css/reconnect.css"></link>';
    return cb();
}

exports.handleMessage = function(hook_name, {message, socket}, cb) {
    if (areParamsOk === false) return false;

    var type = message.type;
    if (type === 'CLIENT_READY' || type === 'COLLABROOM') {
        var padId = (type === 'CLIENT_READY')
          ? message.padId :
          Object.keys(socket.rooms)[1];

        getPad(padId, null, function(callback, pad) {

            // If this is a new pad, there's nothing to do
            if (pad.getHeadRevisionNumber() !== 0) {
                var getLastEdit = getLastEditFun(pad)

                getLastEdit(function(callback, timestamp) {
                    if (timestamp !== undefined && timestamp !== null) {
                        var currentTime = (new Date).getTime();

                        // Are we over delay?
                        if ((currentTime - timestamp) > (delay * 1000)) {

                            getHTML(padId, undefined, function(err, d) {
                                if (err) {
                                    return cb(err);
                                }
                                fs.writeFile('deleted_pads/'+padId+'-'+currentTime+'.html', d.html, function(err) {
                                    if (err) {
                                        return cb(err);
                                    }
                                    // Remove pad
                                    removePad(padId);
                                    logger.info('Pad '+padId+' deleted since expired (delay: '+delay+' seconds, last edition: '+timestamp+').');

                                    // Create new pad with an explanation
                                    getPad(padId, replaceText, function() {
                                        // Create disconnect message
                                        var msg = {
                                            type: "COLLABROOM",
                                            data: {
                                                type: "CUSTOM",
                                                payload: {
                                                    authorId: message.authorId,
                                                    action: "requestRECONNECT",
                                                    padId: padId
                                                }
                                            }
                                        };
                                        // Send disconnect message to all clients
                                        var sessions = padMessageHandler.sessioninfos;
                                        Object.keys(sessions).forEach(function(key){
                                            var session = sessions[key];
                                            padMessageHandler.handleCustomObjectMessage(msg, false, function(){
                                                // TODO: Error handling
                                            }); // Send a message to this session
                                        });
                                        if (type === 'COLLABROOM') {
                                            cb(null);
                                        } else {
                                            cb();
                                        }
                                    });
                                });
                            });
                        } else {
                            logger.debug('Nothing to do with '+padId+' (not expired)');
                            cb();
                        }
                    }
                });
            } else {
                logger.info('New or empty pad '+padId);
                cb()
            }
        });
    } else {
        cb();
    }
};

exports.registerRoute  = function (hook_name, args, cb) {
    args.app.get('/ttl/:pad', function(req, res, next) {
        var padId = req.params.pad;

        res.header("Access-Control-Allow-Origin", "*");
        res.setHeader('Content-Type', 'application/json');

        doesPadExist(padId, function(callback, doesExist) {
            if (doesExist === false) {
                res.send('{"ttl": null, "msg": "Empty pad"}');
            } else {
                getPad(padId, null, function(callback, pad) {

                    // If this is a new pad, there's nothing to do
                    if (pad.getHeadRevisionNumber() !== 0) {
                      var getLastEdit = getLastEditFun(pad)

                      getLastEdit(function(callback, timestamp) {
                            if (timestamp !== undefined && timestamp !== null) {
                                var currentTime = (new Date).getTime();

                                var ttl = Math.floor((delay * 1000 - (currentTime - timestamp))/1000);
                                res.send('{"ttl": '+ttl+'}');
                            }
                        });
                    } else {
                        res.send('{"ttl": null, "msg": "New or empty pad"}');
                    }
                });
            }

        });
    });
    cb && cb();
}

function wrapPromise (p, cb) {
  return p.then(function (result) { cb(null, result); })
    .catch(function(err) { cb(err); });
}

function callbackify0 (fun) {
  return function (cb) {
    return wrapPromise(fun(), cb);
  };
};

function callbackify1 (fun) {
  return function (arg1, cb) {
    return wrapPromise(fun(arg1), cb);
  };
};

function callbackify2 (fun) {
  return function (arg1, arg2, cb) {
    return wrapPromise(fun(arg1, arg2), cb);
  };
};

function getLastEditFun (pad) {
  var fun = pad.getLastEdit.bind(pad)

  if (usePromises) {
    return callbackify0(fun)
  }

  return fun
}

function getRemoveFun (pad) {
  var fun = pad.remove.bind(pad)

  if (usePromises) {
    return callbackify0(fun)
  }

  return fun
}
