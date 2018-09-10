var spawn = require('child_process').spawnSync;
var path = require("path");
var maxLength = 36;
var UIDblock = 'xxxxxxxxxxxx';
var isWin = (/^win/.test(process.platform));

/**
 * spawnCmd         :   
 *              shell           :   [exec, args1, args2, ...]
 *              copy            :   [source, destination]
 * spawnType        :   'shell' / 'copy'
 * spawnLocal       :   
 *              shell && true   :   override default SSH method and launch exec locally
 *              copy            :   
 *                  true        :   source = local   
 *                  false       :   destination = local
 * server_config    :
    {
        "method"                : "ssh/local",
        "sshExec"               : "/usr/bin/ssh",
        "defaultOpts"           : "-o StrictHostKeyChecking=no",
        "scpExec"               : "/usr/bin/scp",
        "username"              : "user",
        "uid"                   : "10000",
        "gid"                   : "10000",
        "serverName"            : "pbsserver",
        "secretAccessKey"       : "/home/user/.ssh/id_rsa",
        "localShell"            : "/bin/sh",
        "localCopy"             : "/bin/cp",
        "useSharedDir"          : true,
        "sharedDir"             : "/localMount",
        "workingDir"            : "/tmp",
    }
 * opts             :   spawn default options    
 * **/
function spawnProcess(spawnCmd, spawnType, spawnLocal, server_config, opts){
    var spawnExec;
    var spawnOpts = opts || {};
    spawnOpts.encoding  = spawnOpts.encoding    || 'utf8';
    spawnOpts.timeout   = spawnOpts.timeout     || 5000;
    if(!server_config.defaultOpts){
        server_config.defaultOpts = '';
    }
    // Use UID and GID on local method, Windows does not support UID/GID
    if((!isWin) && (server_config.method === "local" || server_config.useSharedDir || spawnLocal)){
        server_config.uid = Number(server_config.uid);
        server_config.gid = Number(server_config.gid);
        // UID and GID throw a core dump if not correct numbers
        if ( isNaN(server_config.uid) || isNaN(server_config.gid) ) {
            return {stderr : "Please specify valid uid/gid"};
        }else{
            spawnOpts.uid = server_config.uid;
            spawnOpts.gid = server_config.gid;
        }
    }
    switch (spawnType){
        case "shell":
            // Certain shell commands can use the mounted Path, if so use Local
            if(server_config.method === "local" || spawnLocal){
                spawnExec = spawnCmd.shift();
                if(!isWin){
                    spawnOpts.shell = server_config.localShell;
                }
            }else{
                spawnExec = server_config.sshExec;
                spawnCmd = [sshAddress(server_config),"-i",server_config.secretAccessKey].concat(server_config.defaultOpts.split(' ')).concat(spawnCmd);
            }
            break;
        //Copy the files according to the spawnCmd array : 0 is the file, 1 is the destination dir
        case "copy":
            switch (server_config.method){
                // Build the scp command
                case "ssh":
                    var file;
                    var destDir;
                    // Special case if we can use a shared file system
                    if (server_config.useSharedDir){
                        /**
                         * sharedDir -> sharedDir = cp remotely
                         * else      -> sharedDir = cp localy
                         * **/
                         
                        spawnExec = server_config.localCopy;
                        spawnOpts.shell = server_config.localShell;
                        // Replace the remote working dir by the locally mounted folder
                        if(spawnLocal){
                            if(spawnCmd[0].startsWith(server_config.sharedDir)){
                                spawnCmd[0] = getOriginalPath(server_config, spawnCmd[0]);
                                spawnCmd.unshift(server_config.localCopy);
                                return spawnProcess(spawnCmd,"shell",null,server_config);
                            }else{
                                file    = spawnCmd[0];
                                destDir = getMountedPath(server_config, spawnCmd[1]);
                            }
                        }else{
                            if(spawnCmd[1].startsWith(server_config.sharedDir)){
                                spawnCmd[1] = getOriginalPath(server_config, spawnCmd[1]);
                                spawnCmd.unshift(server_config.localCopy);
                                return spawnProcess(spawnCmd,"shell",null,server_config);
                            }else{
                                file    = getMountedPath(server_config, spawnCmd[0]);
                                destDir = spawnCmd[1];
                            }
                        }
                        // Fail-safe for same-file copy
                        if(file === path.join(destDir, path.basename(file))){
                            return true;
                        }
                        spawnCmd = [quotes(file),quotes(destDir)];
                    }else{
                        spawnExec = server_config.scpExec;
                        if(spawnLocal){
                            file    = spawnCmd[0];
                            destDir = sshAddress(server_config) + ":" + spawnCmd[1];
                        }else{
                            file    = sshAddress(server_config) + ":" + spawnCmd[0];
                            destDir = spawnCmd[1];
                        }
                        spawnCmd = server_config.defaultOpts.split(' ').concat(["-i",server_config.secretAccessKey,file,destDir]);
                    }
                    break;
                case "local":
                    spawnExec = server_config.localCopy;
                    spawnOpts.shell = (isWin ? true : server_config.localShell);
                    file        = spawnCmd[0];
                    destDir     = spawnCmd[1];
                    spawnCmd    = [quotes(file),quotes(destDir)];
                    break;
            }
            break;
    }
    var spawnReturn = spawn(spawnExec, spawnCmd, spawnOpts);
    if(spawnReturn.stderr){
        // Restart on first connect
        if(spawnReturn.stderr.indexOf("Warning: Permanently added") > -1){
            return spawn(spawnExec, spawnCmd, spawnOpts);
        }else{
            spawnReturn.error = spawnReturn.stderr;
        }
    }
    return spawnReturn;
}


function sshAddress(server_config){
    return server_config.username + "@" + server_config.serverName;
}

function quotes(text){
    return "\"" + text + "\"";
}

function getMountedPath(server_config, remotePath){
    var mountedPath;
    if(server_config.method === 'ssh' && server_config.useSharedDir){
        var subDir = path.relative(server_config.workingDir, remotePath);
        mountedPath = path.join(server_config.sharedDir, subDir);
    }else if(server_config.method === 'local'){
        mountedPath = path.normalize(remotePath);
    }else{
        // Unavailable
        mountedPath = null;
    }
    return mountedPath;
}

function getOriginalPath(server_config, remotePath){
    var originalPath;
    if(server_config.useSharedDir){
        var subDir = path.relative(server_config.sharedDir, remotePath);
        originalPath = path.join(server_config.workingDir, subDir);
    }else{
        originalPath = path.normalize(remotePath);
    }
    return originalPath;
}

// Create an unique identifier and takes an optional text as part of the UID
function createUID(text){
    // Create a directory 
    var folderName = '';
    var suffix = '';
    
    // Etract first 23 characters
    if(text){
        folderName += text.substr(0, maxLength-(UIDblock.length + 1));
        suffix += '-' + UIDblock;
    }else{
        suffix += UIDblock + '-' + UIDblock;    
    }
    
    folderName +=  suffix.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
    
    return folderName;
}

// Create a unique working directory in the global working directory from the config
// Takes an optional text or base path for the name of the working directory
function createJobWorkDir(server_config, folder, callback){
    
    var args = [];
    for (var i = 0; i < arguments.length; i++) {
        args.push(arguments[i]);
    }

    // first argument is the config file
    server_config = args.shift();

    // last argument is the callback function
    callback = args.pop();
    
    if(args.length === 1){
        // Takes a string to create the working directory
        folder = createUID(args.pop());
    }else{
        // Generate a UID for the working dir
        folder = createUID();
    }
    
    var jobWorkingDir = path.join(server_config.workingDir, folder);

    // Return a locally available job Directory
    var mountedWorkingDir = null;
    
    // Can we create on the mounted Dir
    var usedDir;
    if (server_config.useSharedDir){
        mountedWorkingDir = path.join(server_config.sharedDir, folder);
        usedDir = mountedWorkingDir;
    }else{
        usedDir = jobWorkingDir;
    }
    
    var chmod = "";
    // Special permissions on working folder
    if(!isWin && server_config.permissions){
        chmod = "-m " + server_config.permissions + " ";
    }
    
    //Create workdir with 700 permissions
    var mkdir;
    if(isWin){
        mkdir = spawnProcess([
            process.env.comspec, '/c', 'IF NOT EXIST ' + jobWorkingDir + ' ' + 
            process.env.comspec + ' /c mkdir ' +jobWorkingDir
            ] ,"shell", null, server_config);
    }else{
        //Create workdir with 700 permissions
        mkdir = spawnProcess(["[ -d "+usedDir+" ] || mkdir " + chmod + usedDir],"shell", server_config.useSharedDir, server_config);
    }
    
    // Transmit the error if any
    if (mkdir.stderr){
        return callback(new Error(mkdir.stderr));
    }
    
    //TODO:handles error
    return callback(null, jobWorkingDir, mountedWorkingDir);
}

module.exports = {
    spawn               :       spawnProcess,
    getMountedPath      :       getMountedPath,
    getOriginalPath     :       getOriginalPath,
    createUID           :       createUID,
    createJobWorkDir    :       createJobWorkDir
};