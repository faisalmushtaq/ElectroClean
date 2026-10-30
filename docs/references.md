# References

Every reference below was checked against publisher, Crossref, PubMed or arXiv
records during development (October 2026). DOIs are given so that each can be
re-checked.

## Annotation vocabulary and data standards

Beniczky, S., Aurlien, H., Brøgger, J. C., Fuglsang-Frederiksen, A.,
Martins-da-Silva, A., Trinka, E., et al. (2013). Standardized Computer-based
Organized Reporting of EEG: SCORE. *Epilepsia*, 54(6), 1112–1124.
https://doi.org/10.1111/epi.12135

Beniczky, S., Aurlien, H., Brøgger, J. C., Hirsch, L. J., Schomer, D. L.,
Trinka, E., et al. (2017). Standardized computer-based organized reporting of
EEG: SCORE – Second version. *Clinical Neurophysiology*, 128(11), 2334–2346.
https://doi.org/10.1016/j.clinph.2017.07.418

Hermes, D., Pal Attia, T., Beniczky, S., Bosch-Bayard, J., Delorme, A.,
Lundstrom, B. N., Rogers, C., Rampp, S., Shirazi, S. Y., Truong, D.,
Valdes-Sosa, P., Worrell, G., Makeig, S., & Robbins, K. (2025). Hierarchical
Event Descriptor library schema for EEG data annotation. *Scientific Data*, 12,
1448. https://doi.org/10.1038/s41597-025-05791-2

Kemp, B., & Olivan, J. (2003). European data format 'plus' (EDF+), an EDF
alike standard format for the exchange of physiological data. *Clinical
Neurophysiology*, 114(9), 1755–1761.
https://doi.org/10.1016/S1388-2457(03)00123-8

Kemp, B., Värri, A., Rosa, A. C., Nielsen, K. D., & Gade, J. (1992). A simple
format for exchange of digitized polygraphic recordings.
*Electroencephalography and Clinical Neurophysiology*, 82(5), 391–393.
https://doi.org/10.1016/0013-4694(92)90009-7

Pernet, C. R., Appelhoff, S., Gorgolewski, K. J., Flandin, G., Phillips, C.,
Delorme, A., & Oostenveld, R. (2019). EEG-BIDS, an extension to the brain
imaging data structure for electroencephalography. *Scientific Data*, 6, 103.
https://doi.org/10.1038/s41597-019-0104-8

Oostenveld, R., & Praamstra, P. (2001). The five percent electrode system for
high-resolution EEG and ERP measurements. *Clinical Neurophysiology*, 112(4),
713–719. https://doi.org/10.1016/S1388-2457(00)00527-7

BIDS contributors. Brain Imaging Data Structure specification, appendix
Coordinate systems. https://bids-specification.readthedocs.io/en/stable/appendices/coordinate-systems.html
(CapTrak is right-anterior-superior; EEGLAB, EEGLAB-HJ, CTF, 4DBti and
KitYokogawa are anterior-left-superior; checked 29 October 2026)

BIDS contributors. Brain Imaging Data Structure specification,
Electroencephalography, Channels description (`*_channels.tsv`).
https://bids-specification.readthedocs.io/en/stable/modality-specific-files/electroencephalography.html
(`name`, `type` and `units` are required; the optional `status` is `good` or
`bad`, with a free-text `status_description` explaining why a channel was
declared bad; checked 30 October 2026). ElectroTag writes an annotator's bad
channels in this form (docs/file_formats.md, `…_channels.tsv`).

HED Working Group. HED SCORE library schema 2.2.0, with the HED standard
schema 8.5.0.
https://raw.githubusercontent.com/hed-standard/hed-schemas/main/library_schemas/score/hedxml/HED_score_2.2.0.xml
(SHA-256 db6fc134…e70e72, the file of `hed_score_2.2.0_validation.json`;
checked 30 October 2026). `Data-artifact` (`Property/Data-property/Data-artifact`,
HED_0012493, "An anomalous, interfering, or distorting signal originating from
a source other than the item being studied") is the parent of every artifact
term, and ElectroTag offers it as Uncertain / needs review. The schema has no
modifier for an uncertain artifact type: its `Property-not-possible-to-determine`
(HED_0042396) belongs to the feature properties of findings, and its
`Uncertain-significant-pattern` to EEG patterns, so neither is used.

## EEG recordings used to test the readers

The public recordings below were used on 30 October 2026 to check that the browser reads recordings
of 2 to 257 channels as MNE-Python reads them (docs/testing_guide.md, "Real recordings"). None of
them is in the repository. Each entry was checked against the dataset's own page and its DOI, and
its licence against the dataset's description; the PhysioNet databases are under the Open Data
Commons Attribution License v1.0 and the OpenNeuro datasets under CC0. The OpenNeuro entries give
the authors as each dataset's description gives them, in the order of the datasets' accession
numbers.

Guttag, J. (2010). CHB-MIT Scalp EEG Database (version 1.0.0). PhysioNet.
https://doi.org/10.13026/C2K01R (ODC-By 1.0). Its original publication: Shoeb,
A. H. (2009). Application of machine learning to epileptic seizure onset
detection and treatment [Doctoral thesis, Massachusetts Institute of
Technology]. http://hdl.handle.net/1721.1/54669

Kemp, B. (2013). Sleep-EDF Database Expanded (version 1.0.0). PhysioNet.
https://doi.org/10.13026/C2X676 (ODC-By 1.0). Its original publication: Kemp,
B., Zwinderman, A. H., Tuk, B., Kamphuisen, H. A. C., & Oberyé, J. J. L.
(2000). Analysis of a sleep-dependent neuronal feedback loop: the slow-wave
microcontinuity of the EEG. *IEEE Transactions on Biomedical Engineering*,
47(9), 1185–1194. https://doi.org/10.1109/10.867928

Pollard, T., Moody, B. E., Lehman, L. H., Gow, B. J., Fernandes, C., Xie, C.,
Johnson, A., Mark, R. G., & Heldt, T. (2026). PhysioNet as a global platform
for biomedical research. *Nature Health*, 1, 792–795.
https://doi.org/10.1038/s44360-026-00096-z (the citation PhysioNet asks for
with its databases)

Schalk, G. (2009). EEG Motor Movement/Imagery Dataset (version 1.0.0).
PhysioNet. https://doi.org/10.13026/C28G6P (ODC-By 1.0). Its original
publication: Schalk, G., McFarland, D. J., Hinterberger, T., Birbaumer, N., &
Wolpaw, J. R. (2004). BCI2000: a general-purpose brain-computer interface (BCI)
system. *IEEE Transactions on Biomedical Engineering*, 51(6), 1034–1043.
https://doi.org/10.1109/TBME.2004.827072

Arnaud Delorme & Scott Makeig (2021). Visual Oddball Task (256 channels)
(version 1.1.0) [Data set]. OpenNeuro ds002578.
https://doi.org/10.18112/openneuro.ds002578.v1.1.0 (CC0)

Ahmad Mheich, Olivier Dufor, Sahar Yassine, Aya Kabbara, Arnaud Biraben,
Fabrice Wendling, et al. (2020). HD-EEGtask(Dataset 1) (version 1.0.2) [Data
set]. OpenNeuro ds003420. https://doi.org/10.18112/openneuro.ds003420.v1.0.2
(CC0)

Ahmad Mheich, Olivier Dufor, Sahar Yassine, Aya Kabbara, Arnaud Biraben,
Fabrice Wendling, et al. (2020). HD-EEGtask(Dataset 2) (version 1.0.2) [Data
set]. OpenNeuro ds003421. https://doi.org/10.18112/openneuro.ds003421.v1.0.2
(CC0)

Yulin Wang, Wei Duan, Debo Dong, Lihong Ding, & Xu Lei (2022). A test-retest
resting and cognitive state EEG dataset (version 1.0.1) [Data set]. OpenNeuro
ds004148. https://doi.org/10.18112/openneuro.ds004148.v1.0.1 (CC0)

Giovanni M Di Liberto, Michael P Broderick, Ole Bialas, & Edmund C Lalor
(2023). EEG responses to continuous naturalistic speech (version 1.0.8) [Data
set]. OpenNeuro ds004408. https://doi.org/10.18112/openneuro.ds004408.v1.0.8
(CC0)

Seitaro Iwama, Masumi Morishige, Yoshikazu Takahashi, Ryotaro Hirose, Midori
Kodama, & Junichi Ushiba (2023). The BMI-HDEEG dataset 4 (version 1.0.2) [Data
set]. OpenNeuro ds004448. https://doi.org/10.18112/openneuro.ds004448.v1.0.2
(CC0)

Joseph H. Rudoler, Matthew R. Dougherty, Brandon S. Katerman, James P. Bruska,
Woohyeuk Chang, David J. Halpern, et al. (2023). Spatial memory and
non-invasive closed-loop stimulus timing (version 1.0.0) [Data set]. OpenNeuro
ds004706. https://doi.org/10.18112/openneuro.ds004706.v1.0.0 (CC0)

Yukako Ito (2024). UV_EEG (version 1.0.0) [Data set]. OpenNeuro ds005274.
https://doi.org/10.18112/openneuro.ds005274.v1.0.0 (CC0)

Zhao Xiangyue, Zhou Jingyao, Zhang Libo, Duan Haoqing, Wei Shiyu, Bi Yanzhi, et
al. (2024). 26 By Biosemi (version 1.0.0) [Data set]. OpenNeuro ds005284.
https://doi.org/10.18112/openneuro.ds005284.v1.0.0 (CC0)

Zhao Xiangyue, Zhou Jingyao, Zhang Libo, Duan Haoqing, Wei Shiyu, Bi Yanzhi, et
al. (2024). 39 By BP (version 1.0.0) [Data set]. OpenNeuro ds005289.
https://doi.org/10.18112/openneuro.ds005289.v1.0.0 (CC0)

Eduardo López-Larraz, María Sierra-Torralba, Sergio Clemente, Galit Fierro,
David Oriol, Javier Minguez, et al. (2026). The Bitbrain Open Access Sleep
(BOAS) dataset (version 1.1.3) [Data set]. OpenNeuro ds005555.
https://doi.org/10.18112/openneuro.ds005555.v1.1.3 (CC0)

María Melcón, Enrique Stern, Lydia Arana, & Almudena Capilla (2025). EEG data
during three near-threshold visual detection tasks: a no-cue task, a
noninformative cue task (50% validity), and an informative cue task (100%
validity) (version 1.0.0) [Data set]. OpenNeuro ds006171.
https://doi.org/10.18112/openneuro.ds006171.v1.0.0 (CC0)

Petunia Reinke, Lisa Deneke, & Sebastian Ocklenburg (2026). EEG-Asymmetries
Dataset (version 1.0.0) [Data set]. OpenNeuro ds007172.
https://doi.org/10.18112/openneuro.ds007172.v1.0.0 (CC0)

Tamari Shalamberidze, Kyle Nash, & Jeremy B. Caplan (2026). Resting-State EEG
and Trait Anxiety (version 1.0.0) [Data set]. OpenNeuro ds007609.
https://doi.org/10.18112/openneuro.ds007609.v1.0.0 (CC0)

Laura Raiff, Gabrielle Bulter, Kailyn McFarlane, Bharath Chandrasekaran, &
Kevin R. Sitek (2026). Auditory-motor EEG (one-channel) (version 1.0.4) [Data
set]. OpenNeuro ds008161. https://doi.org/10.18112/openneuro.ds008161.v1.0.4
(CC0)

## Software

Gramfort, A., Luessi, M., Larson, E., Engemann, D. A., Strohmeier, D.,
Brodbeck, C., Goj, R., Jas, M., Brooks, T., Parkkonen, L., & Hämäläinen, M.
(2013). MEG and EEG data analysis with MNE-Python. *Frontiers in Neuroscience*,
7, 267. https://doi.org/10.3389/fnins.2013.00267

## Web platform and cloud services

Microsoft. (2025). Access shared items (Microsoft Graph v1.0). Microsoft Learn.
https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0
(how a sharing URL is encoded as `u!` and unpadded base64url; anonymous access
does not work for OneDrive for Business and SharePoint)

Microsoft. (2025). Download driveItem content (Microsoft Graph v1.0). Microsoft
Learn. https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
(the `/content` request answers with a redirect to a pre-authenticated
download address, which a request that needs a CORS preflight cannot follow)

MDN contributors. (2026). FileSystemFileHandle: createWritable() method; and
the browser compatibility data of `@mdn/browser-compat-data` 8.1.7.
https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable
(writing from the page arrived in Safari and Safari on iOS 26;
`StorageManager.getDirectory`, `FileSystemFileHandle.getFile` and
`createSyncAccessHandle`, the last only in workers, in 15.2;
`StorageManager.estimate` in 17)

MNE-Python developers. (2026). `mne.channels.make_1020_channel_selections` and
`mne.viz.plot_raw` (MNE 1.13). https://mne.tools/stable/generated/mne.channels.make_1020_channel_selections.html
and https://mne.tools/stable/generated/mne.viz.plot_raw.html (10-20 names
grouped as left for odd numbers, right for even numbers and midline for z; the
browser's trace colours by channel type, with bad channels in light grey)

NeuroScope, part of the NDManager suite. User manual, NeuroScope page, Channel
Colors. https://ndmanager.sourceforge.net/UserManual/neuroscope.html (channels
coloured by anatomical group, by spike group or one by one)

Machado, G. M., Oliveira, M. M., & Fernandes, L. A. F. (2009). A
physiologically-based model for simulation of color vision deficiency. *IEEE
Transactions on Visualization and Computer Graphics*, 15(6), 1291–1298.
https://doi.org/10.1109/TVCG.2009.113

## Filtering

Widmann, A., Schröger, E., & Maess, B. (2015). Digital filter design for
electrophysiological data – a practical approach. *Journal of Neuroscience
Methods*, 250, 34–46. https://doi.org/10.1016/j.jneumeth.2014.08.002

## Agreement statistics

Cohen, J. (1960). A coefficient of agreement for nominal scales. *Educational
and Psychological Measurement*, 20(1), 37–46.
https://doi.org/10.1177/001316446002000104

Fleiss, J. L. (1971). Measuring nominal scale agreement among many raters.
*Psychological Bulletin*, 76(5), 378–382. https://doi.org/10.1037/h0031619

Hayes, A. F., & Krippendorff, K. (2007). Answering the call for a standard
reliability measure for coding data. *Communication Methods and Measures*,
1(1), 77–89. https://doi.org/10.1080/19312450709336664

Feinstein, A. R., & Cicchetti, D. V. (1990). High agreement but low kappa: I.
The problems of two paradoxes. *Journal of Clinical Epidemiology*, 43(6),
543–549. https://doi.org/10.1016/0895-4356(90)90158-L

Cicchetti, D. V., & Feinstein, A. R. (1990). High agreement but low kappa: II.
Resolving the paradoxes. *Journal of Clinical Epidemiology*, 43(6), 551–558.
https://doi.org/10.1016/0895-4356(90)90159-M

Byrt, T., Bishop, J., & Carlin, J. B. (1993). Bias, prevalence and kappa.
*Journal of Clinical Epidemiology*, 46(5), 423–429.
https://doi.org/10.1016/0895-4356(93)90018-V

## Agreement on continuous (unitised) annotations

Krippendorff, K. (1995). On the reliability of unitizing continuous data.
*Sociological Methodology*, 25, 47–76. https://doi.org/10.2307/271061

Mathet, Y., Widlöcher, A., & Métivier, J.-P. (2015). The unified and holistic
method gamma (γ) for inter-annotator agreement measure and alignment.
*Computational Linguistics*, 41(3), 437–479.
https://doi.org/10.1162/COLI_a_00227

## Event matching

Warby, S. C., Wendt, S. L., Welinder, P., Munk, E. G. S., Carrillo, O.,
Sorensen, H. B. D., Jennum, P., Peppard, P. E., Perona, P., & Mignot, E.
(2014). Sleep-spindle detection: crowdsourcing and evaluating performance of
experts, non-experts and automated methods. *Nature Methods*, 11(4), 385–392.
https://doi.org/10.1038/nmeth.2855

Ziyabari, S., Shah, V., Golmohammadi, M., Obeid, I., & Picone, J. (2017).
Objective evaluation metrics for automatic classification of EEG events.
arXiv preprint arXiv:1712.10107. https://doi.org/10.48550/arXiv.1712.10107

## EEG training and assessment

Nascimento, F. A., Gao, H., Katyal, R., Matthews, R., Yap, S. V., Rampp, S.,
Tatum, W. O., Strowd, R. E., & Beniczky, S. (2023). Education Research:
Competency-based EEG education: An online routine EEG examination for adult and
child neurology residents. *Neurology: Education*, 2(4), e200094.
https://doi.org/10.1212/NE9.0000000000200094

Nascimento, F. A., Katyal, R., Olandoski, M., Gao, H., Yap, S., Matthews, R.,
Rampp, S., Tatum, W., Strowd, R., & Beniczky, S. (2024). Expert accuracy and
inter-rater agreement of "must-know" EEG findings for adult and child neurology
residents. *Epileptic Disorders*, 26(1), 109–120.
https://doi.org/10.1002/epd2.20186
