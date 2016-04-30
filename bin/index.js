#! /usr/bin/env node
"use strict";
var program = require("commander");
var _ = require("lodash");
var fs = require("fs-extra");
var path = require("path");
var ProjectGen_1 = require("./gen/ProjectGen");
var Vesta_1 = require("./gen/file/Vesta");
var ModelGen_1 = require("./gen/code/ModelGen");
var NGControllerGen_1 = require("./gen/code/client/ng/NGControllerGen");
var NGDirectiveGen_1 = require("./gen/code/client/ng/NGDirectiveGen");
var NGServiceGen_1 = require("./gen/code/client/ng/NGServiceGen");
var NGFormGen_1 = require("./gen/code/client/ng/NGFormGen");
var NGFilterGen_1 = require("./gen/code/client/ng/NGFilterGen");
var SassGen_1 = require("./gen/file/SassGen");
var CordovaGen_1 = require("./gen/file/CordovaGen");
var Deployer_1 = require("./deploy/Deployer");
var Backuper_1 = require("./deploy/Backuper");
var ExpressControllerGen_1 = require("./gen/code/server/ExpressControllerGen");
var Log_1 = require("./util/Log");
var DockerInstaller_1 = require("./docker/DockerInstaller");
var Util_1 = require("./util/Util");
var packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), { encoding: 'utf8' }));
program.version("Vesta Platform v" + packageInfo.version);
program
    .option('init', 'Initiate a server')
    .option('create [projectName]', 'Create new project by interactive CLI')
    .option('deploy', 'Deploy a project from remote repository')
    .option('plugin', 'Adding a Cordova Plugin')
    .option('gen [model, controller, directive, service] name', 'Generate code for mentioned type')
    .option('deploy [httpRepoPath]')
    .option('backup [deployFileName]');
//program
//    .command('create [projectName]', 'Create new project by interactive CLI')
//    .command('plugin [name]');
program.parse(process.argv);
var args = program['rawArgs'];
args.shift();
args.shift();
var command = args.shift();
switch (command) {
    case 'create':
        createProject();
        break;
    case 'plugin':
        handleCordovaPlugin(args);
        break;
    case 'gen':
        generateCode(args);
        break;
    case 'deploy':
        deployProject(args);
        break;
    case 'backup':
        backupProject(args);
        break;
    case 'init':
        initProject();
        break;
    default:
        Log_1.Log.error('Invalid operation');
}
function createProject() {
    var _a = program['create'].split('/'), projectCategory = _a[0], projectName = _a[1];
    if (!projectName) {
        projectName = projectCategory;
        projectCategory = '';
    }
    if (!projectName.match(/^[a-z][a-z0-9-_]+/i)) {
        return console.error('projectName may only contains [letters, numbers, dash, underscore]');
    }
    projectName = _.camelCase(projectName);
    ProjectGen_1.ProjectGen.getGeneratorConfig(projectName, projectCategory)
        .then(function (config) {
        var project = new ProjectGen_1.ProjectGen(config);
        project.generate();
    });
}
function handleCordovaPlugin(args) {
    var cordova = CordovaGen_1.CordovaGen.getInstance(), subCommand = args.shift();
    if (subCommand == 'add') {
        cordova.install.apply(cordova, args);
    }
    else {
        cordova.uninstall.apply(cordova, args);
    }
}
function generateCode(args) {
    var type = args.shift().toLowerCase();
    var name = args[0];
    if (!name || !name.match(/^[a-z][a-z0-9\-_]+/i)) {
        return Log_1.Log.error('Please enter a valid name');
    }
    var vesta = Vesta_1.Vesta.getInstance(), projectConfig = vesta.getConfig();
    switch (type) {
        case 'controller':
            if (projectConfig.type == ProjectGen_1.ProjectGen.Type.ClientSide) {
                NGControllerGen_1.NGControllerGen.getGeneratorConfig(function (config) {
                    config.name = name;
                    var ngController = new NGControllerGen_1.NGControllerGen(config);
                    ngController.generate();
                });
            }
            else {
                ExpressControllerGen_1.ExpressControllerGen.getGeneratorConfig(name, function (config) {
                    var controller = new ExpressControllerGen_1.ExpressControllerGen(config);
                    controller.generate();
                });
            }
            break;
        case 'model':
            var model = new ModelGen_1.ModelGen(args);
            model.generate();
            break;
        case 'directive':
            NGDirectiveGen_1.NGDirectiveGen.getGeneratorConfig(function (config) {
                config.name = name;
                var ngDirective = new NGDirectiveGen_1.NGDirectiveGen(config);
                ngDirective.generate();
            });
            break;
        case 'filter':
            NGFilterGen_1.NGFilterGen.getGeneratorConfig(function (config) {
                config.name = name;
                var ngFilter = new NGFilterGen_1.NGFilterGen(config);
                ngFilter.generate();
            });
            break;
        case 'service':
            NGServiceGen_1.NGServiceGen.getGeneratorConfig(function (config) {
                config.name = name;
                var ngService = new NGServiceGen_1.NGServiceGen(config);
                ngService.generate();
            });
            break;
        case 'form':
            NGFormGen_1.NGFormGen.getGeneratorConfig(function (config) {
                config.name = name;
                config.writeToFile = true;
                var ngForm = new NGFormGen_1.NGFormGen(config);
                ngForm.generate();
            });
            break;
        case 'sass':
            var sass = new SassGen_1.SassGen(args[1], args[0]);
            sass.generate();
            break;
        default:
            Log_1.Log.error("Invalid generator option " + type);
    }
}
function initProject() {
    Util_1.Util.prompt({
        name: 'initType',
        message: 'Choose one of the following operations',
        type: 'list',
        choices: ['Install Docker', 'Install DockerCompose']
    })
        .then(function (answer) {
        switch (answer.initType) {
            case 'Install Docker':
                var instlr = new DockerInstaller_1.DockerInstaller();
                instlr.installEngine();
                break;
            case 'Install DockerCompose':
                var instlr = new DockerInstaller_1.DockerInstaller();
                instlr.installCompose();
        }
    });
}
function deployProject(args) {
    Deployer_1.Deployer.getDeployConfig(args)
        .then(function (config) {
        var deployer = new Deployer_1.Deployer(config);
        deployer.deploy();
    });
}
function backupProject(args) {
    Backuper_1.Backuper.getDeployConfig(args)
        .then(function (config) {
        var backuper = new Backuper_1.Backuper(config);
        backuper.backup();
    });
}
