var request = require('request');
var fs = require('fs');
var dateformat = require('dateformat');
var async = require('async');
var crypto = require('crypto');
var path = require('path');
var prettyBytes = require('pretty-bytes');
var et = require('elementtree');

//For debug, accept self signed ssl 
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

module.exports = {
    uploadFolder: uploadFolder,
    uploadFile: uploadFile
};

function getAllFilesInFolder(dir, ignore) {
    var results = [];

    fs.readdirSync(dir).forEach(function(file) {
        if (dir.slice(-1) !== path.sep)
            file = dir + path.sep + file;
        else
            file = dir + file;

        var stat = undefined;;
        try
        {
            stat = fs.statSync(file);
        } catch (e)
        {
            stat = undefined;
        }
        if (stat) {
            if (stat.isDirectory()) 
                results = results.concat(getAllFilesInFolder(file, ignore))
            else 
            {
                var ignoreFile = false;
                ignore.forEach(function(element) {
                    if (file.indexOf(element) > -1) {
                        ignoreFile = true;
                    }
                }, this);
                
                if (!ignoreFile)
                    results.push(file);
            }
        } 
    });

    return results;
};

function uploadFolder (config, remotePath, localFolder, ignore) {
    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': Scanning ' + localFolder);
    if (ignore[0])
        console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': Ignoring files matching: ' + ignore);
    
    var files = getAllFilesInFolder(localFolder, ignore);

    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': Uploading ' + files.length + ' files');

    async.eachLimit(files, 1, function(file, done) {
        var fileName = path.basename(file);
        var folder = path.dirname(file);
        
        //Remove initial path, convert to web url
        folder = folder.replace(localFolder, '');
        folder = folder.replace('\\', '/');
        
        try
        {
            uploadFile(config, remotePath + folder, file, function (err) {
                if (err)
                    done(err);
                else 
                    done();
            });
        } catch (e) {            
            done(e);
        }
    },
    function error(err) {
        if (err)
            console.error(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': ERROR: ' + err);
    });
}
    
function uploadFile(config, remotePath, localFile, callback)
{    
    // Calculate MD5 hash of file
    var fd = fs.createReadStream(localFile);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');

    fd.on('end', function() {
        hash.end();
        var md5hash = hash.read(); 
        
        checkIfFileExists(config, remotePath, localFile, md5hash, function (status) {
            if (status === 200) {
                console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': File "' + localFile + '" already exists, skipping.');
                if (callback)
                    callback();
            } else if (status === 404) {
                //File not already on remote, upload file
                uploadFileToRemote(config, remotePath, localFile, md5hash, function (status) {
                    if (!status || (status !== 200 && status !== 201)) {
                        console.error(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') + ': ERROR: Failed to upload "' + localFile + '", response ' + status); 
                    }
                    
                    if (callback)
                        callback();                       
                });
            } else {
                console.error(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': ERROR: Unknown status ' + status);
                if (callback)
                    callback("Error");
            }
        });
    });

    // read all file and pipe it (write it) to the hash object
    fd.pipe(hash);
}

function uploadFileToRemote(config, remotePath, localFile, md5hash, callback)
{
    var fileName = path.basename(localFile);
    var stats = fs.statSync(localFile);        
    var options = {
        url: 'https://up.jottacloud.com/jfs/' + encodeURI(config.username + '/' + remotePath + '/' +  fileName) + '?umode=nomultipart',
        headers: {
            'User-Agent': 'node-jfs https://github.com/paaland/node-jfs',
            'JMd5': md5hash,
            'JCreated': stats.ctime,
            'JModified': stats.mtime,
            'JSize': stats.size
        }
    };

    //console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') + ': Uploading "' +  localFile + '", ' + prettyBytes(stats.size));
    
    var start = new Date();    
    
    //Upload file
    fs.createReadStream(localFile)
        .pipe(req = request.post(options)
            .auth(config.username, config.password, true)
            .on('error', function(error) {
                console.error(error)
                callback(error.statusCode);                        
            })
            .on('drain', () => {                
                var time = new Date()-start;
                var mins = time / (1000*60);
                var bps = req.req.connection.bytesWritten / mins;
                process.stdout.write('\r' + dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') + ': Uploading "' +  localFile + '", ' + prettyBytes(req.req.connection.bytesWritten)  + ' of ' + prettyBytes(stats.size) + ' uploaded (' + prettyBytes(bps) + '/min)     ');
            })
            .on('response', function(response) {
                process.stdout.write('\n');
                callback(response.statusCode);
            })
        );
}

function checkIfFileExists(config, remotePath, localFile, md5hash, callback)
{
    var fileName = path.basename(localFile);
    var stats = fs.statSync(localFile);        
    var options = {
        url: 'https://jfs.jottacloud.com/jfs/' + encodeURI(config.username + '/' + remotePath + '/' +fileName) + '?cphash=' + md5hash,
        headers: {
            'User-Agent': 'node-jfs https://github.com/paaland/node-jfs',
            'JMd5': md5hash,
            'JCreated': stats.ctime,
            'JModified': stats.mtime,
            'JSize': stats.size
        }
    };
    
    //Check if file with same name, size, md5hash, modified date and created date exists
    request.post(options, function (error, response, body) {        
         if (!error && response.statusCode == 200) {
             if (fileIsComplete(body))
                callback(response.statusCode);
            else
                callback(404);                
         } else
            callback(404);
        })
        .auth(config.username, config.password, true);
}

function fileIsComplete(body) 
{
    var file = et.parse(body);
    var state = file.findtext('latestRevision/state');
    if (!state)
        state = file.findtext('currentRevision/state');
    
    // console.log('Body: ' + body);
    // console.log('Check: ' + state);

    return state === 'COMPLETED';
}
        
