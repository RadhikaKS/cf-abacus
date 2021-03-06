'use strict';

// Simulate a service provider submitting usage for a resource, check the
// usage report for those submissions and measure the performance.

// TODO Use Hystrix metrics for internal performance measurements

// Scenarios:
// - Concurrently submit a usage doc for a resource instance
// - Concurrently submit a usage doc for multiple resource instances
// - Concurrently submit a usage doc for multiple organizations
// - TODO add resource and space variations
// - TODO submit batch of usage docs in each submission

const { each, range, omit, extend, clone } = require('underscore');

const async = require('async');
const commander = require('commander');

const batch = require('abacus-batch');
const breaker = require('abacus-breaker');
const request = require('abacus-request');
const retry = require('abacus-retry');
const util = require('util');
const dbclient = require('abacus-dbclient');
const moment = require('abacus-moment');
const oauth = require('abacus-oauth');

const brequest = retry(breaker(batch(request)), {
  retries: 20,
  min: 1000,
  max: Infinity
});
const usage = require('./usage.js');

// Setup the debug log
const debug = require('abacus-debug')('abacus-perf-test');
const xdebug = require('abacus-debug')('x-abacus-perf-test');

process.env.DB = process.env.DB || 'test';

// Parse command line options
const argv = clone(process.argv);
argv.splice(1, 1, 'perf');
commander
  .option('-o, --orgs <n>', 'number of organizations', parseInt)
  .option('-i, --instances <n>', 'number of resource instances', parseInt)
  .option('-u, --usagedocs <n>', 'number of usage docs', parseInt)
  .option('-d, --delta <d>', 'usage time window shift in milli-seconds', parseInt)
  .option('--no-timestamp', 'do not add timestamp to org names', false)
  .option('--num-executions <n>', 'number of test executions', 1)
  .option('--limit <n>', 'max number of parallel submissions', parseInt)
  .option('-t, --start-timeout <n>', 'external processes start timeout in milliseconds', parseInt)
  .option('-x, --total-timeout <n>', 'test timeout in milliseconds', parseInt)
  .option(
    '-c, --collector <uri>',
    'usage collector URL or domain name [http://localhost:9080]',
    'http://localhost:9080'
  )
  .option(
    '-r, --reporting <uri>',
    'usage reporting URL or domain name [http://localhost:9088]',
    'http://localhost:9088'
  )
  .option(
    '-a, --auth-server <uri>',
    'authentication server URL or domain name [http://localhost:9882]',
    'http://localhost:9882'
  )
  .allowUnknownOption(true)
  .parse(argv);

// Number of organizations
const orgs = commander.orgs || 1;

// Number of resource instances
const resourceInstances = commander.instances || 1;

// Number of usage docs
const usagedocs = commander.usagedocs || 1;

// Usage time window shift in milli-seconds
const delta = commander.delta || 0;

// External Abacus processes start timeout
const startTimeout = commander.startTimeout || 10000;

// This test timeout
const totalTimeout = commander.totalTimeout || 60000;

const numExecutions = commander.numExecutions;

const timestamp = commander.timestamp;

const limit = commander.limit;

// Collector service URL
const collector = commander.collector;

// Reporting service URL
const reporting = commander.reporting;

// Auth server URL
const authServer = commander.authServer;

// Use secure routes or not
const secured = () => process.env.SECURED === 'true';

const objectStorageToken = secured()
  ? oauth.cache(
    authServer,
    process.env.OBJECT_STORAGE_CLIENT_ID,
    process.env.OBJECT_STORAGE_CLIENT_SECRET,
    'abacus.usage.object-storage.write'
  )
  : undefined;

const systemToken = secured()
  ? oauth.cache(authServer, process.env.SYSTEM_CLIENT_ID, process.env.SYSTEM_CLIENT_SECRET, 'abacus.usage.read')
  : undefined;

describe('abacus-perf-test', () => {
  before((done) => {
    if (objectStorageToken)
      objectStorageToken.start((err) => {
        if (err) console.log('Could not fetch object storage token due to, %o', err);
      });

    if (systemToken)
      systemToken.start((err) => {
        if (err) console.log('Could not fetch system token due to, %o', err);
      });

    if(/.*localhost.*/.test(collector))
      // drop all abacus collections except plans and plan-mappings
      dbclient.drop(process.env.DB, /^abacus-((?!plan).)*$/, done);
    else done();
  });

  it('measures performance of concurrent usage submissions', function(done) {
    // Configure the test timeout based on the number of usage docs or
    // a preset timeout
    console.log('Testing with %d orgs, %d resource instances, %d usage docs with limit %d',
      orgs, resourceInstances, usagedocs, limit);
    const timeout = Math.max(totalTimeout, 100 * orgs * resourceInstances * usagedocs);
    this.timeout(timeout + 2000);
    const processingDeadline = moment.now() + timeout;

    console.log('Timeout %d, num executions %d', timeout, numExecutions);

    const authHeader = (token) =>
      token
        ? {
          headers: {
            authorization: token()
          }
        }
        : {};

    const post = (organization, resourceInstance, docNumber, timestamp, cb) => {
      const usageDoc = usage.usageTemplate(organization, resourceInstance, docNumber, delta, timestamp);
      xdebug('Submitting org: %d instance: %d usage doc: %d %o',
        organization + 1, resourceInstance + 1, docNumber + 1, usageDoc);
      brequest.post(`${collector}/v1/metering/collected/usage`,
        extend({}, authHeader(objectStorageToken), { body: usageDoc }),
        (err, val) => {
          expect(err).to.equal(undefined);
          expect(val.statusCode).to.equal(201);
          debug('Submitted org:%d instance:%d usage:%d', organization + 1, resourceInstance + 1, docNumber + 1);
          cb(err, val);
        }
      );
    };

    // Post the requested number of usage docs
    const submit = (done) => {
      const numDocs = orgs * resourceInstances * usagedocs;

      const functions = [];
      each(range(usagedocs), (usageDoc) =>
        each(range(resourceInstances), (resourceInstance) =>
          each(range(orgs), (org) => {
            functions.push((cb) => post(org, resourceInstance, usageDoc, timestamp, cb));
          })));

      console.log('Submitting %d usage docs ...', numDocs);
      if (isNaN(limit))
        async.parallel(functions, done);
      else
        async.parallelLimit(functions, limit, done);
    };

    // Get a usage report for the test organization
    const get = (org, done) => {
      brequest.get(`${reporting}/v1/metering/organizations/${usage.orgId(org, timestamp)}/aggregated/usage`,
        extend({}, authHeader(systemToken)),
        (err, val) => {
          expect(err).to.equal(undefined);
          expect(val.statusCode).to.equal(200);

          // Compare the usage report we got with the expected report
          xdebug('Processed %d usage docs for org%d', usage.processed(val), org + 1);
          try {
            // Can't check the dynamic time in resource_instances
            val.body.spaces[0].consumers[0].resources[0].plans[0] = omit(
              val.body.spaces[0].consumers[0].resources[0].plans[0],
              'resource_instances'
            );
            const stippedResponse = usage.fixup(omit(val.body, 'id', 'processed', 'processed_id', 'start', 'end'));
            const expected = usage.fixup(
              usage.report(org, resourceInstances, usagedocs, numExecutions, timestamp)
            );
            expect(stippedResponse).to.deep.equal(expected);
            debug('Report for org:%d verified successfully', org + 1);

            done();
          } catch (e) {
            xdebug('Failed obtaining report for org:%d, response: %s, %o', org + 1, val ? val.statusCode : 'error', e);
            // If the comparison fails we'll be called again to retry
            // after 250 msec, but give up after the computed timeout
            if (moment.now() >= processingDeadline) {
              console.log(
                '\n',
                util.inspect(val.body, {
                  depth: 20
                }),
                '\n'
              );
              throw e;
            }
          }
        }
      );
    };

    // Wait for the expected usage report for all organizations, get an organization usage report until
    // we get the expected values indicating that all submitted usage has been processed
    const wait = (done) => {
      const functions = [];
      each(range(orgs), (org) => {
        functions.push((cb) => {
          const interval = setInterval(() => get(org, () => cb(clearInterval(interval))), 1000);
        });
      });

      console.log('\nRetrieving usage reports ...', isNaN(limit));
      if (isNaN(limit))
        async.parallel(functions, done);
      else
        async.parallelLimit(functions, limit, done);
    };

    // Wait for usage reporter to start
    request.waitFor(reporting + '/batch', extend({}, authHeader(systemToken)), startTimeout, (err) => {
      // Failed to ping usage reporter before timing out
      if (err) throw err;

      // Run the above steps
      submit(() => wait(done));
    });
  });
});
