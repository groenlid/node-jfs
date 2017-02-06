var request = require('request');
var fs = require('fs');
var querystring = require('querystring');
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

function getAllFilesInFolder(dir) {
    var results = [];

    fs.readdirSync(dir).forEach(function(file) {
        file = dir + path.sep + file;
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
                results = results.concat(getAllFilesInFolder(file))
            else 
                results.push(file);
        } 
    });

    return results;
};

function uploadFolder (config, remotePath, localFolder) {
    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': Scanning ' + localFolder);
    var files = getAllFilesInFolder(localFolder);

    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': Uploading ' + files.length + ' files');

    async.eachLimit(files, 4, function(file, done) {
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
        console.error(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': ERROR: ' + err);
    });

    // files.forEach(function(file) {
    //     var fileName = path.basename(file);
    //     var folder = path.dirname(file);
        
    //     //Remove initial path, convert to web url
    //     folder = folder.replace(localFolder, '');
    //     folder = folder.replace('\\', '/');
        
    //     this.uploadFile(config, remotePath + folder, file);
    // }, this);
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
                console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': File already exists, skipping.');
                if (callback)
                    callback();
            } else if (status === 404) {
                //File not already on remote, upload file
                uploadFileToRemote(config, remotePath, localFile, md5hash, function (status) {
                    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') + ': File "' + localFile + '" uploaded, response ' + status); 
                    if (callback)
                        callback();                       
                });
            } else {
                console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') +': ERROR: Unknown status ' + status);
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
        url: 'https://up.jottacloud.com/jfs/' + config.username + '/' + remotePath + '/' + fileName + '?umode=nomultipart',
        headers: {
            'User-Agent': 'node-jfs https://github.com/paaland/node-jfs',
            'JMd5': md5hash,
            'JCreated': stats.ctime,
            'JModified': stats.mtime,
            'JSize': stats.size
        }
    };

    console.log(dateformat(new Date(), 'dd.mm.yyyy HH:MM:ss') + ': Uploading "' +  localFile + '", ' + prettyBytes(stats.size));
        
    //Upload file
    fs.createReadStream(localFile)
        .pipe(request.post(options))
        .auth(config.username, config.password, true)
        .on('error', function(error) {
            console.error(error)
            callback(error.statusCode);                        
        })
        .on('response', function(response) {
            callback(response.statusCode);
        });
}

function checkIfFileExists(config, remotePath, localFile, md5hash, callback)
{
    var fileName = path.basename(localFile);
    var stats = fs.statSync(localFile);        
    var options = {
        url: 'https://jfs.jottacloud.com/jfs/' + config.username + '/' + remotePath + '/' + fileName + '?cphash=' + md5hash,
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
    
    return state === 'COMPLETED';
}
        
