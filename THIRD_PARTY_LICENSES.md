# Third-party software notices

This document lists third-party software redistributed inside the
GTFS Express Docker images and the obligations carried by their
licenses.

GTFS Express itself is dual-licensed under
[AGPL-3.0](LICENSE) and a [commercial license](COMMERCIAL_LICENSE.md).
The notices below are independent of that licensing — they apply
specifically to the third-party components we ship inside our
distribution.

---

## MobilityData GTFS Validator (Java)

| Field | Value |
|---|---|
| Component | `gtfs-validator-cli.jar` |
| Version | 8.0.0 |
| Upstream | https://github.com/MobilityData/gtfs-validator |
| Release | https://github.com/MobilityData/gtfs-validator/releases/tag/v8.0.0 |
| Copyright | © MobilityData |
| License | Apache License, Version 2.0 — see full text below |
| How we use it | Embedded as-is in the API Docker image (`/opt/gtfs-validator-cli.jar`); spawned via `java -jar` by [`canonicalValidatorService.js`](GTFS-EXPRESS-API/src/services/canonicalValidatorService.js). |
| Modifications | None. The JAR is downloaded unmodified from the official GitHub release during Docker image build (see [`GTFS-EXPRESS-API/Dockerfile`](GTFS-EXPRESS-API/Dockerfile)). |

### Compliance summary

- **Section 4.1** (include a copy of the License with every Object
  form distribution): satisfied by:
  - this file (`THIRD_PARTY_LICENSES.md`) shipped in every Source
    distribution of GTFS Express, and
  - the upstream `LICENSE` fetched from the same release tag at
    Docker image build time and stored at
    `/opt/gtfs-validator-LICENSE` inside the API image (see
    [`GTFS-EXPRESS-API/Dockerfile`](GTFS-EXPRESS-API/Dockerfile)).
    The MobilityData JAR does not embed a `META-INF/LICENSE` file
    of its own, hence the explicit fetch.
- **Section 4.2** (mark modified files): N/A — we do not modify the
  JAR.
- **Section 4.3** (preserve copyright/patent/trademark/attribution
  notices): satisfied — the JAR is shipped unmodified.
- **Section 4.4** (include `NOTICE` content if present): not
  applicable — the upstream MobilityData repository does not ship a
  `NOTICE` file at the v8.0.0 release.

To bump the validator version, change the `GTFS_VALIDATOR_VERSION`
ARG in [`GTFS-EXPRESS-API/Dockerfile`](GTFS-EXPRESS-API/Dockerfile) and
update the version + URLs in this file.

---

## OpenJDK 17 (JRE Headless, Alpine)

| Field | Value |
|---|---|
| Component | `openjdk17-jre-headless` (Alpine package) |
| Source | https://openjdk.org / Alpine Linux package repository |
| License | GNU General Public License v2 with the **Classpath Exception** (GPL-2.0 WITH Classpath-exception-2.0) |
| How we use it | Installed via `apk add` in the API image to host the MobilityData JAR. Invoked but not modified. |

The Classpath Exception explicitly allows linking the JRE with code
under any license (including AGPL, commercial) without the AGPL
copyleft cascading into the JRE itself. Reciprocally, GTFS Express
code does not contaminate the JRE distribution.

License text: <https://openjdk.org/legal/gplv2+ce.html>

---

## SheetJS Community Edition (`xlsx`)

| Field | Value |
|---|---|
| Component | `xlsx` npm package (SheetJS CE) |
| Version | 0.20.3 |
| Upstream | https://sheetjs.com / https://git.sheetjs.com/sheetjs/sheetjs |
| Distribution | Official SheetJS CDN tarball, pinned in `GTFS-EXPRESS-API/package.json` as `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (integrity hash in the lockfile) |
| Copyright | © SheetJS LLC |
| License | Apache License, Version 2.0 — see full text below |
| How we use it | Server-side parsing of user-uploaded XLSX chat attachments (`GTFS-EXPRESS-API/src/services/chatAttachmentService.js`). Not modified, not bundled into frontend assets. |

**Why the CDN tarball and not the npm registry:** the registry copy of
`xlsx` is frozen at 0.18.5, which is affected by CVE-2023-30533
(prototype pollution, fixed in 0.19.3) and CVE-2024-22363 (ReDoS, fixed
in 0.20.2). SheetJS distributes patched Community Edition builds only
through its own CDN. Never downgrade this dependency back to the
registry version.

---

## Inter (font, web frontend)

| Field | Value |
|---|---|
| Component | `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2` (Inter, variable weight, Latin and Latin Extended subsets) |
| Version | as packaged by `@fontsource-variable/inter` 5.3.0 on the npm registry (tarball sha256 `d26710dd38e7217484a1d47ee76c024977ec550548876f26d06ed1844af09a14`) |
| Upstream | https://github.com/rsms/inter |
| Copyright | © 2016 The Inter Project Authors |
| License | SIL Open Font License, Version 1.1 — full text in [`GTFS-EXPRESS-WEB/src/assets/fonts/inter/LICENSE.txt`](GTFS-EXPRESS-WEB/src/assets/fonts/inter/LICENSE.txt) |
| How we use it | Served by the site itself (bundled by Vite into the frontend image), declared in [`inter.css`](GTFS-EXPRESS-WEB/src/assets/fonts/inter/inter.css): no font CDN is called, so the visitor's address is not sent to one. |
| Modifications | None: the woff2 files are the package's, unmodified. |

### Compliance summary

- **OFL condition 2** (redistribute with the copyright notice and the license): satisfied by `LICENSE.txt` beside the files in the source, and by this notice.
- **Condition 3** (Reserved Font Name): not applicable — the font is not modified and keeps its name.
- **Condition 4** (no use of the authors' names to promote): respected.
- **Condition 5** (the font stays under the OFL): the font files are not relicensed by GTFS Express's own licensing.

---

## Geist and Geist Mono (fonts, web frontend: the Network Studio)

| Field | Value |
|---|---|
| Component | `geist-latin-wght-normal.woff2`, `geist-latin-ext-wght-normal.woff2`, `geist-mono-latin-wght-normal.woff2`, `geist-mono-latin-ext-wght-normal.woff2` (Geist and Geist Mono, variable weight, Latin and Latin Extended subsets) |
| Version | as packaged by `@fontsource-variable/geist` 5.3.0 (tarball sha256 `533dd66117795ac12316fb05fce27736c4bc63c31613b302d0a5285ca3a291d7`) and `@fontsource-variable/geist-mono` 5.3.0 (tarball sha256 `af7a9f156602b859efa95cd1acb824a5322c51a1eca53afb38ed033885736a70`) on the npm registry |
| Upstream | https://github.com/vercel/geist-font |
| Copyright | © 2024 The Geist Project Authors |
| License | SIL Open Font License, Version 1.1 — full text in [`GTFS-EXPRESS-WEB/src/assets/fonts/geist/LICENSE.txt`](GTFS-EXPRESS-WEB/src/assets/fonts/geist/LICENSE.txt) (Geist) and [`LICENSE-mono.txt`](GTFS-EXPRESS-WEB/src/assets/fonts/geist/LICENSE-mono.txt) (Geist Mono) |
| How we use it | Served by the site itself (bundled by Vite into the frontend image), declared in [`geist.css`](GTFS-EXPRESS-WEB/src/assets/fonts/geist/geist.css), used by the project's pages (the Network Studio): no font CDN is called. |
| Modifications | None: the woff2 files are the packages', unmodified (the `@font-face` declares a narrower weight range; the files are untouched). |

### Compliance summary

- **OFL condition 2**: satisfied by `LICENSE.txt` and `LICENSE-mono.txt` beside the files in the source, and by this notice.
- **Condition 3** (Reserved Font Name): not applicable — the fonts are not modified and keep their names.
- **Condition 4** (no use of the authors' names to promote): respected.
- **Condition 5** (the fonts stay under the OFL): the font files are not relicensed by GTFS Express's own licensing.

---

## Test data: real GTFS feeds (test fixtures only, not shipped in the images)

`GTFS-EXPRESS-API/src/__tests__/fixtures/real/` holds two unmodified
open-data feeds used to test the transformation engine on real networks:

- `albi-libea-urbain.zip` — libéA Urbain, Communauté d'agglomération de
  l'Albigeois, from transport.data.gouv.fr. Open Database License (ODbL) 1.0
  (https://opendatacommons.org/licenses/odbl/1-0/). A public database
  derived from it must be shared under the ODbL with this attribution.
- `vernon-sngo.zip` — SNgo! (Vernon / Les Andelys), Syndicat mixte Atoumod,
  from transport.data.gouv.fr. Licence Ouverte / Open Licence 2.0 (Etalab).

Sources, dates and checksums: `fixtures/real/README.md`.

## Apache License, Version 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for describing the origin of the Work and
      reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may accept support,
      warranty, indemnity, or other liability obligations and/or rights
      consistent with this License. However, in accepting such obligations,
      You may act only on Your own behalf and on Your sole responsibility,
      not on behalf of any other Contributor, and only if You agree to
      indemnify, defend, and hold each Contributor harmless for any
      liability incurred by, or claims asserted against, such Contributor
      by reason of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
   implied. See the License for the specific language governing
   permissions and limitations under the License.
```
