# configure-build

Action for applying the Bonsai Foundation standard versioning and release scheme to Harp device repositories in GitHub Actions workflows.

The action determines the build version from the event that triggered the workflow, exports it for the rest of the build to consume, and reports whether the repository contains Bonsai workflows that need to be rendered for documentation.

## Usage

Invoke the action early in your build job, after checking out the repository:

```yml
- name: Configure build
  id: configure-build
  uses: harp-tech/configure-build@v2
```

The action exports two environment variables for later steps to consume:

- `CiBuildVersion` is the version to build. It comes from the release tag on a release, from the version input on a manual dispatch, and otherwise from the most recent release with a continuous-integration suffix appended.
- `CiIsForRelease` is `true` when the build is producing a public release and `false` otherwise.

This fork exports one further variable:

- `CiFirmwarePreviewVersion` is the workflow run number on a continuous-integration build, and `v` on a release.

It also sets the `need-workflow-image-render` output, which is `true` when the repository contains Bonsai workflows that need images rendered for the documentation website. Expose it as a job output so later jobs can decide whether to run the rendering step:

```yml
jobs:
  build:
    outputs:
      need-workflow-image-render: ${{steps.configure-build.outputs.need-workflow-image-render}}
```

### Documentation workflow detection

By default the action looks for Bonsai workflows under `docs/workflows/` and `docs/examples/`. Override the search with the `documentation-workflows` input:

```yml
- name: Configure build
  id: configure-build
  uses: harp-tech/configure-build@v2
  with:
    documentation-workflows: |
      docs/workflows/**/*.bonsai
      docs/examples/**/*.bonsai
```

### Device metadata

When a `device.yml` file is present in the repository root, the declared `firmwareVersion` takes part in determining the build version. On a release, or on a manual dispatch with an explicit version, the declared firmware major and minor version must match the requested version exactly, otherwise the build fails.

On a continuous-integration build the version comes from the most recent release, and the declared firmware major and minor version must be at least as high, otherwise the build fails. When the declared version is higher, the build version uses it, with the patch number reset to zero.

## Relationship to the upstream action

This action is a fork of [bonsai-rx/configure-build](https://github.com/bonsai-rx/configure-build), which applies the same versioning and release scheme to Bonsai package repositories. The major version tracks the upstream major version, so `v2` of this action is built on `v2` of the upstream action, while the minor and patch numbers are specific to this repository.

## Documentation

See [action.yml](action.yml) for the full list of input parameters and outputs supported by this action.
