const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const { createMatchers, anyMatch, cacheFile, flatMap } = require('./helpers');

function filterData(tzdata, config) {
  const moment = require('moment-timezone/moment-timezone-utils');
  const momentHasCountries = Boolean(tzdata.countries); // moment-timezone >= 0.5.28
  const { matchZones, matchCountries, startYear, endYear } = config;
  const hasMatchCountries = matchCountries != null;
  const hasMatchZones = matchZones != null;

  let { version, zones } = tzdata;

  // Unpack necessary data.
  // "America/Anchorage|US/Alaska" -> ["America/Anchorage", "US/Alaska"]
  let links = tzdata.links.map(link => link.split('|'));

  let zoneMatchers = createMatchers(matchZones);
  let countryCodeMatchers = [/./];
  let countryZoneMatchers = [/./];

  if (matchCountries) {
    countryCodeMatchers = createMatchers(matchCountries);
    const countryCodes = tzdata.countries
      .map(country => country.split('|'))
      .filter(country => anyMatch(country[0], countryCodeMatchers));
    const countryZones = flatMap(countryCodes, country =>
      country[1].split(' ').filter(zone => anyMatch(zone, zoneMatchers))
    );
    countryZoneMatchers = createMatchers(countryZones);
  }

  if (hasMatchCountries || hasMatchZones) {
    // Find all links that match anything in the matcher list.
    links = links.filter(link => anyMatch(link[1], zoneMatchers, countryZoneMatchers));

    // If links exist, add the links’ destination zones to the matcher list.
    if (links.length) {
      // De-duplicate the link sources.
      const uniqueLinkSources = new Set(links.map(link => link[0]));
      const linkMatchers = createMatchers(Array.from(uniqueLinkSources));
      zoneMatchers = zoneMatchers.concat(linkMatchers);
    }
  }

  // Find all zones that match anything in the matcher list (including link destinations).
  const zoneMap = new Map();
  zones = zones
    .filter(zone => {
      const zoneName = zone.split('|')[0];
      return anyMatch(zoneName, zoneMatchers, countryZoneMatchers);
    })
    .map(zone => {
      const unpacked = moment.tz.unpack(zone);
      zoneMap.set(unpacked.name, unpacked);
      return unpacked;
    });

  // Normalise links to become full copies of their destination zones.
  // This helps to avoid bugs when links end up pointing to other links, as detailed at
  // https://github.com/gilmoreorless/moment-timezone-data-webpack-plugin/pull/6
  links.forEach(link => {
    const linkClone = {
      ...zoneMap.get(link[0]),
      name: link[1],
    };
    zones.push(linkClone);
  });

  // Find all countries that contain the matching zones.
  let newCountryData = [];
  if (momentHasCountries) {
    newCountryData = tzdata.countries
      .map(country => {
        const [name, zonesStr] = country.split('|');
        const zones = zonesStr.split(' ');
        const matchingZones = zones.filter(zone => anyMatch(zone, zoneMatchers));
        // Manually map country data to the required format for filterLinkPack, as moment-timezone
        // doesn't yet provide an unpack() equivalent for countries.
        return {
          name,
          zones: matchingZones
        };
      })
      .filter(country =>
        country.zones.length > 0 &&
        anyMatch(country.name, countryCodeMatchers)
      );
  }

  // Finally, run the whole lot through moment-timezone’s inbuilt packing method.
  const filteredData = moment.tz.filterLinkPack(
    {
      version,
      zones,
      links: [], // Deliberately empty to ensure correct link data is generated from the zone data.
      countries: newCountryData,
    },
    startYear,
    endYear
  );
  return filteredData;
}

function throwInvalid(message) {
  throw new Error(`MomentTimezoneDataPlugin: ${message}`);
}

function validateOptions(options) {
  const filteringOptions = ['matchZones', 'matchCountries', 'startYear', 'endYear'];
  const otherOptions = ['cacheDir'];
  const knownOptions = filteringOptions.concat(otherOptions);
  const optionNames = Object.keys(options);
  let usedFilteringOptions = [];
  let unknownOptions = [];
  optionNames.forEach(name => {
    if (!knownOptions.includes(name)) {
      unknownOptions.push(name);
    }
    if (filteringOptions.includes(name)) {
      usedFilteringOptions.push(name);
    }
  });

  // Unknown options
  if (unknownOptions.length) {
    throwInvalid(
      `Unknown options provided (${unknownOptions.join(', ')}). ` +
      `Supported options are: ${knownOptions.join(', ')}.`
    );
  }

  // At least one option required
  if (!usedFilteringOptions.length) {
    throwInvalid('Must provide at least one filtering option.');
  }

  // Don't allow matchCountries when the data doesn't support it
  if (options.matchCountries !== undefined) {
    const tzdata = require('moment-timezone/data/packed/latest.json');
    if (!tzdata.countries) {
      throwInvalid('The matchCountries option can only work with moment-timezone 0.5.28 or later.');
    }
  }

  // Invalid years
  ['startYear', 'endYear'].forEach(option => {
    if (option in options && !Number.isInteger(options[option])) {
      throwInvalid(`Invalid option — ${option} must be an integer.`);
    }
  });

  // Invalid cache dir (not a valid path)
  if ('cacheDir' in options) {
    try {
      path.parse(options.cacheDir);
    } catch (error) {
      throwInvalid(`Provided cacheDir is an invalid path: '${options.cacheDir}'`);
    }
  }
}

function MomentTimezoneDataPlugin(options = {}) {
  validateOptions(options);

  const startYear = options.startYear || -Infinity;
  const endYear = options.endYear || Infinity;
  const matchZones = options.matchZones || /./;
  const matchCountries = options.matchCountries || null;
  const cacheDir = options.cacheDir || null;

  return new webpack.NormalModuleReplacementPlugin(
    /data[\\/]packed[\\/]latest\.json$/,
    resource => {
      if (resource.context.match(/node_modules[\\/]moment-timezone$/)) {
        const config = { matchZones, matchCountries, startYear, endYear };
        const tzdata = require('moment-timezone/data/packed/latest.json');
        const file = cacheFile(tzdata, config, cacheDir);
        if (!file.exists) {
          try {
            const filteredData = filterData(tzdata, config, file);
            fs.writeFileSync(file.path, JSON.stringify(filteredData, null, 2));
          } catch (err) {
            console.warn(err); // eslint-disable-line no-console
            return; // Don't rewrite the request
          }
        }
        resource.request = file.path;
      }
    }
  );
}

module.exports = MomentTimezoneDataPlugin;
// Exported for testing purposes only
module.exports.filterData = filterData;
