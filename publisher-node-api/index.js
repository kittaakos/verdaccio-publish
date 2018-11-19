//@ts-check

const fs = require('fs');
const os = require('os');
const path = require('path');
const uuid = require('uuid');
const shell = require('shelljs');
const request = require('request');
const npmLogin = require('npm-cli-login');
const utils = require('verdaccio/build/lib/utils');
const startServer = require('verdaccio').default;

const NPM_REGISTRY = 'http://localhost:4873'

// Reset the registry content.
if (fs.existsSync(path.join(__dirname, '.storage'))) {
    shell.rm('-rf', path.join(__dirname, '.storage'));
}
shell.mkdir(path.join(__dirname, '.storage'));

// Discard the source of the file based authentication.
if (fs.existsSync(path.join(__dirname, 'htpasswd'))) {
    shell.rm('-rf', path.join(__dirname, 'htpasswd'));
}
fs.writeFileSync(path.join(__dirname, 'htpasswd'), '', { encoding: 'utf8' });


const verdaccioConfigPath = path.join(__dirname, 'verdaccio-config.yml');
const verdaccioConfig = utils.parseConfigFile(verdaccioConfigPath);
verdaccioConfig.self_path = verdaccioConfigPath; // This seems to be required by `verdaccio-htpasswd`.
const verdaccioPkgVersion = require(path.resolve(__dirname, 'node_modules', 'verdaccio', 'package.json')).version;
const verdaccioPkgName = require(path.resolve(__dirname, 'node_modules', 'verdaccio', 'package.json')).name;
startServer(verdaccioConfig, undefined, verdaccioConfigPath, verdaccioPkgVersion, verdaccioPkgName, (webServer, address, pkgName, pkgVersion) => {
    webServer.listen(address.port || address.path, address.host, () => {
        shell.echo(`The private NPM registry is listening on ${address.host}:${address.port || address.path()}.`);
        // Add a dummy user to the registry and log in.
        const username = uuid.v4();
        const password = uuid.v4();
        addUser(username, password, NPM_REGISTRY, () => {
            try {
                // Publish the private dependencies.
                [
                    {
                        path: path.join(__dirname, '..', 'my-private-package'),
                        version: '1.0.0'
                    }
                ].forEach(entry => {
                    const name = path.basename(entry.path);
                    shell.echo(`Publishing '${name}' into the private NPM registry.`);
                    exec(`yarn --cwd ${entry.path} publish --registry ${NPM_REGISTRY} --no-git-tag-version --non-interactive --ignore-scripts --new-version ${entry.version}`);
                });

                // Use the private NPM registry to install dependencies:
                shell.echo('🎉');
            } finally {
                webServer.close();
            }
        });
    });
});


/**
 * `registry` must not have the trailing `/`.
 * Good: `http://localhost:1234`.
 * Bad: `http://localhost:1234/`
 */
function addUser(name, password, registry, cb) {
    request.put({
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        url: `${registry}/-/user/org.couchdb.user:${name}`,
        json: {
            name,
            password
        }
    }, (error, response, body) => {
        if (!!response && response.statusCode === 201 && !!body && 'ok' in body && 'token' in body && body.ok) {
            shell.echo(`Successfully added new dummy user: ${name}. Token: ${body.token}`);
            // https://github.com/postmanlabs/npm-cli-login/issues/22
            if (!process.env.HOME) {
                process.env.HOME = os.homedir();
            }
            const npmrc = path.join(os.homedir(), '.npmrc');
            if (!fs.existsSync(npmrc)) {
                fs.closeSync(fs.openSync(npmrc, 'w'));
            }
            fs.appendFileSync(npmrc, `${registry.substring('http:'.length)}/:_authToken=${body.token}\n`);
            npmLogin(name, password, `${name}@${name}.${name}`, registry);
            shell.echo('Successfully logged in.');
            cb();
        } else {
            shell.echo('Cannot add new user.', JSON.stringify({
                error,
                body,
                response
            }));
            process.exit(1);
        }
    });
};

/**
 * Executes the `command` synchronously and returns with the result. Optionally, echos the `echo` argument to the shell before executing the command.
 * If the `code` of the result is not `0`, exists the shell with the non-zero exit code.
 */
function exec(command, echo) {
    if (echo) {
        shell.echo(echo);
    }
    const result = shell.exec(command);
    if (result.code !== 0) {
        shell.exit(result.code);
    }
    return result;
}