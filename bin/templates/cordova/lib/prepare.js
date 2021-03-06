/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var Q = require('q');
var fs = require('fs');
var path = require('path');
var shell = require('shelljs');
var events = require('cordova-common').events;
var AndroidManifest = require('./AndroidManifest');
var xmlHelpers = require('cordova-common').xmlHelpers;
var CordovaError = require('cordova-common').CordovaError;
var ConfigParser = require('cordova-common').ConfigParser;

module.exports.prepare = function (cordovaProject) {

    var self = this;

    this._config = updateConfigFilesFrom(cordovaProject.projectConfig,
        this._munger, this.locations);

    // Update own www dir with project's www assets and plugins' assets and js-files
    return Q.when(updateWwwFrom(cordovaProject, this.locations))
    .then(function () {
        // update project according to config.xml changes.
        return updateProjectAccordingTo(self._config, self.locations);
    })
    .then(function () {
        handleIcons(cordovaProject.projectConfig, self.root);
        handleSplashes(cordovaProject.projectConfig, self.root);
    })
    .then(function () {
        self.events.emit('verbose', 'updated project successfully');
    });
};

/**
 * Updates config files in project based on app's config.xml and config munge,
 *   generated by plugins.
 *
 * @param   {ConfigParser}   sourceConfig  A project's configuration that will
 *   be merged into platform's config.xml
 * @param   {ConfigChanges}  configMunger  An initialized ConfigChanges instance
 *   for this platform.
 * @param   {Object}         locations     A map of locations for this platform
 *
 * @return  {ConfigParser}                 An instance of ConfigParser, that
 *   represents current project's configuration. When returned, the
 *   configuration is already dumped to appropriate config.xml file.
 */
function updateConfigFilesFrom(sourceConfig, configMunger, locations) {
    events.emit('verbose', 'Generating config.xml from defaults for platform "android"');

    // First cleanup current config and merge project's one into own
    // Overwrite platform config.xml with defaults.xml.
    shell.cp('-f', locations.defaultConfigXml, locations.configXml);

    // Then apply config changes from global munge to all config files
    // in project (including project's config)
    configMunger.reapply_global_munge().save_all();

    // Merge changes from app's config.xml into platform's one
    var config = new ConfigParser(locations.configXml);
    xmlHelpers.mergeXml(sourceConfig.doc.getroot(),
        config.doc.getroot(), 'android', /*clobber=*/true);

    config.write();
    return config;
}

/**
 * Updates platform 'www' directory by replacing it with contents of
 *   'platform_www' and app www. Also copies project's overrides' folder into
 *   the platform 'www' folder
 *
 * @param   {Object}  cordovaProject    An object which describes cordova project.
 * @param   {Object}  destinations      An object that contains destination
 *   paths for www files.
 */
function updateWwwFrom(cordovaProject, destinations) {
    shell.rm('-rf', destinations.www);
    shell.mkdir('-p', destinations.www);
    // Copy source files from project's www directory
    shell.cp('-rf', path.join(cordovaProject.locations.www, '*'), destinations.www);
    // Override www sources by files in 'platform_www' directory
    shell.cp('-rf', path.join(destinations.platformWww, '*'), destinations.www);

    // If project contains 'merges' for our platform, use them as another overrides
    var merges_path = path.join(cordovaProject.root, 'merges', 'android');
    if (fs.existsSync(merges_path)) {
        events.emit('verbose', 'Found "merges" for android platform. Copying over existing "www" files.');
        var overrides = path.join(merges_path, '*');
        shell.cp('-rf', overrides, destinations.www);
    }
}

/**
 * Updates project structure and AndroidManifest according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectAccordingTo(platformConfig, locations) {
    // Update app name by editing res/values/strings.xml
    var name = platformConfig.name();
    var strings = xmlHelpers.parseElementtreeSync(locations.strings);
    strings.find('string[@name="app_name"]').text = name;
    fs.writeFileSync(locations.strings, strings.write({indent: 4}), 'utf-8');
    events.emit('verbose', 'Wrote out Android application name to "' + name + '"');

    // Java packages cannot support dashes
    var pkg = (platformConfig.android_packageName() || platformConfig.packageName()).replace(/-/g, '_');

    var manifest = new AndroidManifest(locations.manifest);
    var orig_pkg = manifest.getPackageId();

    manifest.getActivity()
        .setOrientation(findOrientationValue(platformConfig))
        .setLaunchMode(findAndroidLaunchModePreference(platformConfig))
        .setDocumentLaunchMode(findAndroidDocumentLaunchModePreference(platformConfig));

    manifest.setVersionName(platformConfig.version())
        .setVersionCode(platformConfig.android_versionCode() || default_versionCode(platformConfig.version()))
        .setPackageId(pkg)
        .setMinSdkVersion(platformConfig.getPreference('android-minSdkVersion', 'android'))
        .setMaxSdkVersion(platformConfig.getPreference('android-maxSdkVersion', 'android'))
        .setTargetSdkVersion(platformConfig.getPreference('android-targetSdkVersion', 'android'))
        .write();

    var javaPattern = path.join(locations.root, 'src', orig_pkg.replace(/\./g, '/'), '*.java');
    var java_files = shell.ls(javaPattern).filter(function(f) {
        return shell.grep(/extends\s+CordovaActivity/g, f);
    });

    if (java_files.length === 0) {
        throw new CordovaError('No Java files found which extend CordovaActivity.');
    } else if(java_files.length > 1) {
        events.emit('log', 'Multiple candidate Java files (.java files which extend CordovaActivity) found. Guessing at the first one, ' + java_files[0]);
    }

    var destFile = path.join(locations.root, 'src', pkg.replace(/\./g, '/'), path.basename(java_files[0]));
    shell.mkdir('-p', path.dirname(destFile));
    shell.sed(/package [\w\.]*;/, 'package ' + pkg + ';', java_files[0]).to(destFile);
    events.emit('verbose', 'Wrote out Android package name to "' + pkg + '"');

    if (orig_pkg !== pkg) {
        // If package was name changed we need to remove old java with main activity
        shell.rm('-Rf',java_files[0]);
        // remove any empty directories
        var currentDir = path.dirname(java_files[0]);
        var sourcesRoot = path.resolve(locations.root, 'src');
        while(currentDir !== sourcesRoot) {
            if(fs.existsSync(currentDir) && fs.readdirSync(currentDir).length === 0) {
                fs.rmdirSync(currentDir);
                currentDir = path.resolve(currentDir, '..');
            } else {
                break;
            }
        }
    }
}

// Consturct the default value for versionCode as
// PATCH + MINOR * 100 + MAJOR * 10000
// see http://developer.android.com/tools/publishing/versioning.html
function default_versionCode(version) {
    var nums = version.split('-')[0].split('.');
    var versionCode = 0;
    if (+nums[0]) {
        versionCode += +nums[0] * 10000;
    }
    if (+nums[1]) {
        versionCode += +nums[1] * 100;
    }
    if (+nums[2]) {
        versionCode += +nums[2];
    }
    return versionCode;
}

function copyImage(src, resourcesDir, density, name) {
    var destFolder = path.join(resourcesDir, (density ? 'drawable-': 'drawable') + density);
    var isNinePatch = !!/\.9\.png$/.exec(src);
    var ninePatchName = name.replace(/\.png$/, '.9.png');

    // default template does not have default asset for this density
    if (!fs.existsSync(destFolder)) {
        fs.mkdirSync(destFolder);
    }

    var destFilePath = path.join(destFolder, isNinePatch ? ninePatchName : name);
    events.emit('verbose', 'copying image from ' + src + ' to ' + destFilePath);
    shell.cp('-f', src, destFilePath);
}

function handleSplashes(projectConfig, platformRoot) {
    var resources = projectConfig.getSplashScreens('android');
    // if there are "splash" elements in config.xml
    if (resources.length > 0) {
        deleteDefaultResourceAt(platformRoot, 'screen.png');
        events.emit('verbose', 'splash screens: ' + JSON.stringify(resources));

        // The source paths for icons and splashes are relative to
        // project's config.xml location, so we use it as base path.
        var projectRoot = path.dirname(projectConfig.path);
        var destination = path.join(platformRoot, 'res');

        var hadMdpi = false;
        resources.forEach(function (resource) {
            if (!resource.density) {
                return;
            }
            if (resource.density == 'mdpi') {
                hadMdpi = true;
            }
            copyImage(path.join(projectRoot, resource.src), destination, resource.density, 'screen.png');
        });
        // There's no "default" drawable, so assume default == mdpi.
        if (!hadMdpi && resources.defaultResource) {
            copyImage(path.join(projectRoot, resources.defaultResource.src), destination, 'mdpi', 'screen.png');
        }
    }
}

function handleIcons(projectConfig, platformRoot) {
    var icons = projectConfig.getIcons('android');

    // if there are icon elements in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    deleteDefaultResourceAt(platformRoot, 'icon.png');

    var android_icons = {};
    var default_icon;
    // http://developer.android.com/design/style/iconography.html
    var sizeToDensityMap = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };
    // find the best matching icon for a given density or size
    // @output android_icons
    var parseIcon = function(icon, icon_size) {
        // do I have a platform icon for that density already
        var density = icon.density || sizeToDensityMap[icon_size];
        if (!density) {
            // invalid icon defition ( or unsupported size)
            return;
        }
        var previous = android_icons[density];
        if (previous && previous.platform) {
            return;
        }
        android_icons[density] = icon;
    };

    // iterate over all icon elements to find the default icon and call parseIcon
    for (var i=0; i<icons.length; i++) {
        var icon = icons[i];
        var size = icon.width;
        if (!size) {
            size = icon.height;
        }
        if (!size && !icon.density) {
            if (default_icon) {
                events.emit('verbose', 'more than one default icon: ' + JSON.stringify(icon));
            } else {
                default_icon = icon;
            }
        } else {
            parseIcon(icon, size);
        }
    }

    // The source paths for icons and splashes are relative to
    // project's config.xml location, so we use it as base path.
    var projectRoot = path.dirname(projectConfig.path);
    var destination = path.join(platformRoot, 'res');
    for (var density in android_icons) {
        copyImage(path.join(projectRoot, android_icons[density].src), destination, density, 'icon.png');
    }
    // There's no "default" drawable, so assume default == mdpi.
    if (default_icon && !android_icons.mdpi) {
        copyImage(path.join(projectRoot, default_icon.src), destination, 'mdpi', 'icon.png');
    }
}

// remove the default resource name from all drawable folders
function deleteDefaultResourceAt(baseDir, resourceName) {
    shell.ls(path.join(baseDir, 'res/drawable-*'))
    .forEach(function (drawableFolder) {
        var imagePath = path.join(drawableFolder, resourceName);
        shell.rm('-f', [imagePath, imagePath.replace(/\.png$/, '.9.png')]);
        events.emit('verbose', 'Deleted ' + imagePath);
    });
}

/**
 * Gets and validates 'AndroidLaunchMode' prepference from config.xml. Returns
 *   preference value and warns if it doesn't seems to be valid
 *
 * @param   {ConfigParser}  platformConfig  A configParser instance for
 *   platform.
 *
 * @return  {String}                  Preference's value from config.xml or
 *   default value, if there is no such preference. The default value is
 *   'singleTop'
 */
function findAndroidLaunchModePreference(platformConfig) {
    var launchMode = platformConfig.getPreference('AndroidLaunchMode');
    if (!launchMode) {
        // Return a default value
        return 'singleTop';
    }

    var expectedValues = ['standard', 'singleTop', 'singleTask', 'singleInstance'];
    var valid = expectedValues.indexOf(launchMode) >= 0;
    if (!valid) {
        // Note: warn, but leave the launch mode as developer wanted, in case the list of options changes in the future
        events.emit('warn', 'Unrecognized value for AndroidLaunchMode preference: ' +
            launchMode + '. Expected values are: ' + expectedValues.join(', '));
    }

    return launchMode;
}

/**
 * Queries ConfigParser object for the orientation <preference> value. Warns if
 *   global preference value is not supported by platform.
 *
 * @param  {Object} platformConfig    ConfigParser object
 *
 * @return {String}           Global/platform-specific orientation in lower-case
 *   (or empty string if both are undefined).
 */
function findOrientationValue(platformConfig) {

    var ORIENTATION_DEFAULT = 'default';

    var orientation = platformConfig.getPreference('orientation');
    if (!orientation) {
        return ORIENTATION_DEFAULT;
    }

    var GLOBAL_ORIENTATIONS = ['default', 'portrait','landscape'];
    function isSupported(orientation) {
        return GLOBAL_ORIENTATIONS.indexOf(orientation.toLowerCase()) >= 0;
    }

    // Check if the given global orientation is supported
    if (orientation && isSupported(orientation)) {
        return orientation;
    }

    events.emit('warn', 'Unsupported global orientation: ' + orientation +
        '. Defaulting to value: ' + ORIENTATION_DEFAULT);
    return ORIENTATION_DEFAULT;
}

/*
 * Gets and validates 'AndroidDocumentLaunchMode' prepference from config.xml.
 *   Returns preference value and warns if it doesn't seems to be valid
 *
 * @param   {ConfigParser}  platformConfig  A configParser instance for
 *   platform.
 *
 * XXX
 * @return  {String}                  Preference's value from config.xml or
 *   default value, if there is no such preference. The default value is
 *   'singleTop'
 */
function findAndroidDocumentLaunchModePreference(platformConfig) {
    var launchMode = platformConfig.getPreference('AndroidDocumentLaunchMode');
    if (!launchMode) {
        // Return a default value
        return 'none';
    }

    var expectedValues = ['intoExisting', 'always', 'none', 'never'];
    var valid = expectedValues.indexOf(launchMode) >= 0;
    if (!valid) {
        // Note: warn, but leave the launch mode as developer wanted, in case the list of options changes in the future
        events.emit('warn', 'Unrecognized value for AndroidDocumentLaunchMode preference: ' +
            launchMode + '. Expected values are: ' + expectedValues.join(', '));
    } else if (launchMode != 'none' && launchMode != 'never') {
        var mode = findAndroidLaunchModePreference(platformConfig);
        if (mode != 'standard')
            events.emit('warn', 'For values other than "none" and "never" the activity must be defined with launchMode="standard"');
    }

    return launchMode;
}
