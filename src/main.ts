import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { RequestError } from '@octokit/request-error';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as semver from 'semver';
import { SemVer } from 'semver';
import { getFirmwareVersion } from './harp';

async function main(): Promise<void> {
    core.debug(`Starting action invocation`);

    const context = github.context;
    if (core.isDebug()) {
        core.startGroup("Context dump");
        core.info(JSON.stringify(context, null, 2));
        core.endGroup();
    }

    //==============================================================================================================================================================
    // Determine build settings
    //==============================================================================================================================================================
    let useFallbackVersion = false;
    let version: SemVer | null;
    let isForRelease = false;

    // Determine appropriate version based on the event which triggered the workflow
    // Make sure logic relating to isForRelease matches the release package publish step in the workflow
    //TODO: This is a bit weirder now that this script has been promoted into an action
    if (context.eventName == 'release') {
        isForRelease = true;
        const releaseVersionString = context.payload.release.tag_name;
        if (!releaseVersionString) {
            core.setFailed("Release version is missing!");
            return;
        }

        version = semver.parse(releaseVersionString);
        if (!version) {
            core.setFailed(`Release tag '${releaseVersionString}' is not a valid semver version!`);
            return;
        }

        const releaseIsPrerelease = context.payload.release.prerelease;
        if (releaseIsPrerelease !== true && releaseIsPrerelease !== false) {
            core.setFailed("Release prerelease status was invalid or unspecified!");
        }

        //TODO: I think the idea below was to allow steps to trust ${{github.event.release.prerelease}}
        //    Should we just recommend they rely on an output from us instead?

        // There may be steps within the workflow which assume that the prerelease state of the release is correct, so we ensure it is
        // We could implicitly detect things for those steps, but this situation probably indicates user error and handling it this way is easier
        if (version.prerelease.length > 0 && !releaseIsPrerelease) {
            core.setFailed(`The version to be released '${releaseVersionString}' indicates a pre-release version, but the release is not marked as a pre-release!`);
            return;
        }

        core.info(`Got version ${version.format()} from release event.`);
    } else if (context.eventName == 'workflow_dispatch') {
        //TODO: These should use inputs instead
        const versionString = context.payload.inputs?.version;
        if (versionString) {
            version = semver.parse(versionString);
            if (!version) {
                core.setFailed(`Specified version '${versionString}' is not a valid semver version!`);
            } else {
                core.info(`Got version ${version.format()} from workflow dispatch event.`);
            }
        } else {
            version = null;
            useFallbackVersion = true;
        }

        if (context.payload.inputs?.will_publish_packages === 'true') {
            isForRelease = true;

            if (!version) {
                core.setFailed("Publishing packages without specifying a specific version is not permitted.");
            }
        }
    } else {
        switch (context.eventName) {
            case 'push':
            case 'pull_request':
                break;
            default:
                core.warning(`GitHub Actions event '${context.eventName}' was not properly considered when designing the logic of this action!`);
                break;
        }

        version = null;
        useFallbackVersion = true;
    }

    // Determine fallback version based off of most recent release
    if (useFallbackVersion) {
        assert(!version && context.eventName != 'release', "Should not want fallback version when we have a version or we're released!");

        core.info(`Determining version to use based off of last release version...`);
        const token = core.getInput('repo-token', { required: true });
        assert(token, "Must have GitHub token!");

        const owner = context.payload.repository?.owner?.login;
        const repo = context.payload.repository?.name;
        //TODO: Can these ever realistically happen? The field is nullable for some reason
        assert(owner, "Action expects to run with repository context w/ owner!");
        assert(repo, "Action expects to run with repository context w/ name!");

        let latestRelease;
        try {
            latestRelease = await github.getOctokit(token).rest.repos.getLatestRelease({
                owner: owner,
                repo: repo,
            });
        } catch (error) {
            if ((<RequestError>error).status == 404) {
                // We don't consider this to be a fatal error since it can't happen for released packages
                assert(context.eventName != 'release' && !isForRelease, "This really should not be allowed to happen on a release!");

                core.info(`Repository does not appear to have any releases, falling back on 0.0.0`);
                version = semver.parse('0.0.0');
                latestRelease = null;
            }
        }

        if (latestRelease) {
            assert(latestRelease.status == 200, "Expect success if we get a response at all!");

            const versionString = latestRelease.data.tag_name;
            version = semver.parse(versionString);

            if (!version) {
                //TODO: Maybe make this behavior configurable?
                core.warning(`Most recent release '${versionString}' is not a valid semver version, using 0.0.0 instead.`);
                version = semver.parse('0.0.0');
                assert(version);
            }

            core.info(`Got most recent release version: ${version.format()}`);

            if (version.prerelease.length > 0) {
                // If the version is a pre-release version, drop the pre-release and use the main version as-is since presumably the next release
                // will be this version (but without the pre-release part.)
                //
                // We don't want to assume that pre-release versions will always be marked as pre-release releases, so don't rely on that aspect.
                // (Having releases marked as pre-releases has some visibility downsides on GitHub, so it's sensible to remove the designation)
                core.info("Version is a pre-release version, CI version will be the same except without the pre-release suffix");
                version.prerelease = []
                version.format();
            } else {
                // In the case of a stable release, increment the patch number and use that
                version.patch++;
                version.format();
            }
        }

        //---------------------------------------
        // Append the CI prerelease suffix
        //---------------------------------------
        if (!version) {
            assert(process.exitCode, "We expect to be failing in this scenario!");
         } else {
            // For all git refs besides the default branch, include the branch/tag name in the default version string
            //TODO: Might also be nice to include the fork owner if we're running from a fork. (Unfortunately the upstream repo doesn't seem to be in the context?)
            let versionSuffix: string = `ci${context.runNumber}`;
            if (context.ref != `refs/heads/${context.payload.repository?.default_branch ?? 'main'}`) {
                let ref = context.ref;

                // Strip the ref prefix
                const branchPrefix = 'refs/heads/'
                const tagPrefix = 'refs/tags/'
                if (ref.startsWith(branchPrefix)) {
                    ref = ref.substring(branchPrefix.length);
                } else if (ref.startsWith(tagPrefix)) {
                    ref = `tag-${ref.substring(tagPrefix.length)}`
                }

                // Replace illegal characters with dashes
                ref = ref.replace(/[^0-9A-Za-z-]/g, '-');

                versionSuffix = `${ref}-${versionSuffix}`;
            }

            // If prerelease is multi-part we prepend as our own part
            // (We don't want to guess how it's formatted since our conventions don't use multi-part pre-releases but this isn't worth failing over.)
            let newPrerelease;
            if (version.prerelease.length > 1) {
                version.prerelease = [ versionSuffix, ...version.prerelease ];
            } else if (version.prerelease.length == 1) {
                version.prerelease = [ `${version.prerelease[0]}-${versionSuffix}` ];
            } else {
                version.prerelease = [ versionSuffix ];
            }
            version.format();
        }
    }

    // Final version validation
    if (!version) {
        core.setFailed("Did not determine the version number to use.");
        return;
    }

    // Reject build metadata (we don't really expect it to get here.
    if (version.build.length > 0) {
        if (isForRelease) {
            core.setFailed(`Version '${version.format()}' has unexpected build metadata '${version.build.join('.')}', aborting!`);
            return;
        } else {
            core.warning(`Version '${version.format()}' had build metadata '${version.build.join('.')}', it will be ignored.`);
            version.build = [];
            version.format();
        }
    }

    // Make sure none of our modifications broke the semver format
    // (Don't use `semver.valid(version)`, it doesn't actually check anything when you do that!)
    if (!semver.valid(version.format())) {
        core.setFailed(`Internal error: Version '${version.format()}' is not a valid semver!`);
    }

    const metadataPath = "device.yml";
    if (fs.existsSync(metadataPath)) {
        core.info(`Determine version based off device metadata...`);
        const firmwareVersion = getFirmwareVersion(metadataPath)
        if (firmwareVersion === null) {
            core.setFailed(`Internal error: Firmware version in '${metadataPath}' is not a valid semver!`)
            return;
        }

        if (useFallbackVersion) {
            if (firmwareVersion.major < version.major ||
                firmwareVersion.major == version.major && firmwareVersion.minor < version.minor) {
                core.setFailed(`Firmware version '${firmwareVersion.raw}' is lower than CI build version '${version.format()}'!`)
                return;
            }
            else if (firmwareVersion > version) {
                // Higher device metadata versions supersede fallback version major and minor
                version.major = firmwareVersion.major
                version.minor = firmwareVersion.minor;
                version.patch = 0;
            }
        }
        else if (firmwareVersion.major != version.major || firmwareVersion.minor != version.minor) {
            core.setFailed(`Firmware version '${firmwareVersion.raw}' does not match specified version '${version.format()}'!`)
            return;
        }
    }

    //==============================================================================================================================================================
    // Determine if workflow images need to be built
    //==============================================================================================================================================================
    //TODO: Might be interesting support detecting if any existing SVGs are stale
    const documentationWorkflowPaths = core.getInput('documentation-workflows');
    let needWorkflowImageRender = false;
    if (documentationWorkflowPaths) {
        core.debug(`Looking for Bonsai workflows matching patterns '${documentationWorkflowPaths}'`);
        const bonsaiWorkflows = await glob.create(documentationWorkflowPaths, {
            matchDirectories: false,
            implicitDescendants: false,
        });

        for await (const bonsaiWorkflow of bonsaiWorkflows.globGenerator()) {
            core.info(`Found one or more Bonsai workflows used by documentation, image rendering will be needed.`);
            needWorkflowImageRender = true;
            break;
        }

        if (!needWorkflowImageRender) {
            if (!fs.existsSync('.git')) {
                core.warning("Could not locate Bonsai workflows used for documentation, and there's no .git folder in the workspace, did you forget to checkout?");
            } else {
                core.info("No Bonsai workflows were found in documentation-related locations.");
            }
        }
    }

    //==============================================================================================================================================================
    // Emit outputs
    //==============================================================================================================================================================
    core.info(`Configuring build environment to build${isForRelease ? ' and release' : ''} version ${version.format()}`);
    core.exportVariable('CiBuildVersion', version.format());
    core.exportVariable('CiIsForRelease', isForRelease ? 'true' : 'false');
    core.exportVariable('CiFirmwarePreviewVersion', isForRelease ? 'v' : context.runNumber);
    core.setOutput('need-workflow-image-render', needWorkflowImageRender ? 'true' : 'false');
}

// Node's default error printer is extremely obnoxious and tries to be "helpful" by printing the source line where the exception occurred
// This is all well and good, but sometimes the source map lookup fails and it just barfs an extremely long minified source line which is
// not only useless but makes the log much more annoying to read. This behavior is implemented in `GetErrorSource` in `node_errors.cc` and
// seemingly cannot be disabled directly except by overriding the uncaught exception handler, so that's what we do. :/
const actionIsUnderTest = !!process.env['__TEST_INVOCATION_ID'];
process.on('uncaughtException', (err, origin) => {
    // We don't use core.error here as it causes the initialization order to get messed up and might not work as expected
    let message: string = err.stack ?? `${err.message}:\n(Stack trace missing)`;
    if (!actionIsUnderTest) {
        message = message
            .replaceAll('%', '%25')
            .replaceAll('\r', '%0D')
            .replaceAll('\n', '%0A')
            ;
    }
    process.stdout.write(`::error::${message}`);
    if (!process.exitCode) {
        process.exitCode = -1;
    }
});

main();
