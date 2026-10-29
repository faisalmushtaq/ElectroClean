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
