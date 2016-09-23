/*
 * Copyright 2016 Turner Broadcasting System, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const async = require('async'),
    debug = require('debug'),
    moment = require('moment-timezone'),
    request = require('request'),
    ContentRetriever = require('cnn-content-retriever');



/**
 * Generates an RSS feed for Google Newsstand from a single url String or an
 * Array of String urls.  The urls must be valid urls that have been indexed by
 * Hypatia.  Duplicate urls in the Array will be removed.
 *
 * @example
 * 'use strict';
 *
 * const urls = [
 *         'http://www.cnn.com/2016/06/08/travel/hokulea-worldwide-voyage-world-oceans-day/index.html',
 *         'http://www.cnn.com/2016/02/15/travel/russia-lake-baikal/index.html'
 *     ];
 *
 * const fg = new FeedGenerator(urls);
 *
 * @example
 * 'use strict';
 *
 * const fg = new FeedGenerator('http://www.cnn.com/2016/02/15/travel/russia-lake-baikal/index.html');
 *
 * @example
 * 'use strict';
 *
 * const fg = new FeedGenerator();
 *
 * fg.urls = [
 *     'http://www.cnn.com/2016/06/08/travel/hokulea-worldwide-voyage-world-oceans-day/index.html',
 *     'http://www.cnn.com/2016/02/15/travel/russia-lake-baikal/index.html'
 * ];
 */
class FeedGenerator {
    /**
     * @param {String|Array<String>} [urls]
     * An array of string urls to lookup in Hypatia.  If a single url is used as
     * a String it will be converted to an Array.
     */
    constructor(urls) {
        this.blacklist = [
            /\/studentnews\//,
            /\/videos\/spanish\//,
            /fast-facts\/index.html$/,
            /cnn.com\/\d{4}\/\d{2}\/\d{2}\/cnn-info/ // https://regex101.com/r/yT0jX6/1
        ];

        if (urls) {
            this.urls = urls;
        }

        this.dynaimageUrlsToProcess = [];
    }



    /**
     * - Appends to the blacklist of urls not to process
     * - There is currently no way to remove items from the blacklist
     * - Should be an array of regular expression patterns to test against.
     *
     * @param {Array<RegExp>} [blacklistRegexps]
     */
    set blacklist(blacklistRegexps) {
        if (typeof blacklistRegexps === 'string') {
            blacklistRegexps = [blacklistRegexps];
        }

        this._blacklist = (this._blacklist) ? this._blacklist.push(blacklistRegexps) : blacklistRegexps;
    }

    /**
     * Gets the blacklist of urls not to process.
     *
     * @type {Array<RegExp>}
     */
    get blacklist() {
        return this._blacklist;
    }

    /**
     * - Sets or appends to the existing array of string urls to lookup
     * - If a single url is used as a String it will be converted to an Array
     * - There is currently no way to remove a url from the list
     *
     * @type {String|Array<String>}
     *
     * @example
     * 'use strict';
     *
     * const fg = new FeedGenerator();
     *
     * fg.urls = [
     *     'http://www.cnn.com/2016/06/08/travel/hokulea-worldwide-voyage-world-oceans-day/index.html',
     *     'http://www.cnn.com/2016/02/15/travel/russia-lake-baikal/index.html'
     * ];
     */
    set urls(urls) {
        const self = this,
            debugLog = debug('cnn-google-newsstand:FeedGenerator:urls-setter');

        if (urls === 'clear') {
            this._urls = [];
        } else {
            let existingUrls = this._urls || [], // this will be the current value of the urls set on the instance
                filteredUrls = [];               // this will be all of the urls after removing blacklist items

            if (typeof urls === 'string') {
                urls = [urls];
            }

            // add the existingUrls + the new url(s) to be set together and filter based on blacklist
            existingUrls.concat(urls).forEach((url) => {
                if (!self.isOnBlacklist(url)) {
                    filteredUrls.push(url);
                } else {
                    debugLog(`On blacklist, not processing: ${url}`);
                }
            });

            // remove all duplicates and set
            this._urls = Array.from(new Set(filteredUrls));
        }
    }

    /**
     * Gets the array of urls that is set on the instance.
     *
     * @type {Array<String>}
     *
     * @example
     * 'use strict';
     *
     * const fg = new FeedGenerator('http://www.cnn.com/2016/02/15/travel/russia-lake-baikal/index.html');
     *
     * console.log(fg.urls);
     */
    get urls() {
        return this._urls;
    }


    addAnalyticsToLinks(text, publishDate, slug) {
        // TODO handle urls with query strings already attached (there should be none.. we all know how that goes)
        return text.replace(/(<a href="http:\/\/(www|edition).cnn.*?)">(.*?)<\/a>/g, `$1?sr=${publishDate}_${slug}">$3</a>`);
    }

    cutImage(item) {
        let image = (item.cuts.exlarge16to9) ? 'exlarge16to9' : 'large16to9'; // sometimes exlarge16to9 doesn't exist, fall back to large16to9
        return image;
    }

    /**
     * Generates an RSS feed from the resolved models passed into it.
     *
     * @private
     *
     * @param {Array} contentModels
     * An array of resolved models from hypatia.
     *
     * @returns {Promise}
     */
    generateFeed(contentModels) {
        const debugLog = debug('cnn-google-newsstand:FeedGenerator:generateFeed');

        return new Promise((resolve) => {
            let self = this,
                feed = '<?xml version="1.0" encoding="UTF-8"?>',
                bylineLength = undefined;

            feed += '<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">';
            feed += '<channel>';
            feed += '<title>CNN</title>';
            feed += '<link>http://www.cnn.com/</link>';
            feed += '<description>CNN - Breaking News, Daily News and Videos</description>';
            feed += '<language>en-us</language>';
            feed += `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`;

            contentModels.forEach((contentModel) => {
                debugLog(`Mapping: ${contentModel.docs[0].url}`);

                let title = contentModel.docs[0].headline || contentModel.docs[0].title,
                    publishDate = contentModel.docs[0].firstPublishDate,
                    slug = contentModel.docs[0].slug.replace(/\s/g, '-');

                feed += '<item>';
                feed += `<title>${title.trim()}</title>`;
                feed += `<link>${contentModel.docs[0].url.trim()}</link>`;
                feed += `<guid isPermaLink="false">${contentModel.docs[0].sourceId.trim()}</guid>`;
                feed += `<pubDate>${new Date(contentModel.docs[0].lastModifiedDate).toUTCString()}</pubDate>`;

                if (contentModel.docs[0].byline) {
                    bylineLength = contentModel.docs[0].byline.length;

                    feed += `<author>${contentModel.docs[0].byline}</author>`;
                }

                /* PROCESS CONTENT WITH TYPE === ARTICLE */
                if (contentModel.docs[0].type === 'article') {

                    // handle page top media
                    contentModel.docs[0].relatedMedia.media.forEach((item) => {
                        let imageCut = '';


                        if (item.location === 'pageTop') {
                            debugLog(`page top media type: ${item.type}`);

                            // handle page top image
                            if (item.type === 'image') {
                                imageCut = self.cutImage(item);
                                self.dynaimageUrlsToProcess.push(item.cuts[imageCut].url);

                                // feed += `<media:content url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" type="image/jpg" expression="full" width="${item.cuts[imageCut].width}" height="${item.cuts[imageCut].height}">`;
                                feed += `<media:content url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" type="image/jpg" expression="full">`;

                                // TODO - this showing on the template needs to be discussed with Design
                                // if (item.caption && item.caption.trim()) {
                                //     feed += `<media:description type="plain"><![CDATA[${item.caption}]]></media:description>`;
                                // }

                                // if (item.photographer && item.photographer.trim()) {
                                //     feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${item.photographer}]]></media:credit>`;
                                // }

                                feed += '</media:content>';
                            }

                            // handle page top references - video / gallery
                            if (item.type === 'reference') {
                                debugLog(`page top reference type: ${item.referenceType}`);

                                // handle page top gallery (not)
                                // if (item.referenceType === 'gallery') {
                                    // we do not currently support a page top gallery
                                    // this is filtered out upstream
                                    // leaving this block in here for the day that we do support page top galleries
                                // }

                                // handle page top video
                                if (item.referenceType === 'video') {
                                    imageCut = self.cutImage(item);

                                    self.dynaimageUrlsToProcess.push(item.cuts[imageCut].url);

                                    feed += `<media:content url="${item.cdnUrls['1920x1080_5500k_mp4']}" medium="video">`;
                                    feed += `<media:title>${item.headline} 1</media:title>`;
                                    feed += `<media:description><![CDATA[${item.headline}]]></media:description>`;
                                    feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${item.source}]]></media:credit>`;
                                    // TODO add logic for mising thumbnails
                                    // feed += `<media:thumbnail url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" width="${item.cuts[imageCut].width}" height="${item.cuts[imageCut].height}"/>`;
                                    feed += `<media:thumbnail url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}"/>`;
                                    feed += '</media:content>';
                                }
                            }

                        }
                    });

                    // start handling body content
                    feed += '<content:encoded><![CDATA[';

                    // override header content
                    feed += `<meta itemprop="genre" content="${contentModel.docs[0].section}"/>`;

                    if (bylineLength <= 25) {
                        if (contentModel.docs[0].lastPublishDate !== contentModel.docs[0].firstPublishDate) {
                            feed += `<meta itemprop="datePublished" content="
    Updated ${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                        } else {
                            feed += `<meta itemprop="datePublished" content="
    ${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                        }
                    } else {
                        if (contentModel.docs[0].lastPublishDate !== contentModel.docs[0].firstPublishDate) {
                            feed += `<meta itemprop="datePublished" content="Updated ${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                        } else {
                            feed += `<meta itemprop="datePublished" content="${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                        }
                    }


                    // handle editors note
                    if (contentModel.docs[0].body.notes && contentModel.docs[0].body.notes.www) {
                        if (typeof contentModel.docs[0].body.notes.www === 'string') {
                            feed += `<p class="style-id:editorsNote"><em class="style-id:editorsNote">${contentModel.docs[0].body.notes.www.trim()}</em></p>`;
                        }
                    }

                    // handle headlines, paragraphs, and embeds
                    let firstParagraph = true;
                        // previousEmbedType = undefined,
                        // rawEmbed = undefined,
                        // tweetAuthor = undefined,
                        // tweetAuthorName = undefined,
                        // tweetAuthorHandle = undefined,
                        // twitterHandle = undefined,
                        // tweet = undefined,
                        // tweetTimestamp = undefined;

                    contentModel.docs[0].body.paragraphs.forEach(function (paragraph) {
                        if (typeof paragraph.richtext === 'string') {
                            // handle headlines /else/ first paragraph /else/ paragraphs
                            if (paragraph.richtext.startsWith('<h3>')) {
                                feed += `<hr class="style-id:headerDivider">${paragraph.richtext.trim()}`;
                            } else {
                                if (firstParagraph) {
                                    feed += `<p class="style-id:firstParagraph"><span class="style-id:firstParagraphText">${self.addAnalyticsToLinks(paragraph.richtext.trim(), publishDate, slug)}</span></p>`;
                                    firstParagraph = false;
                                } else {
                                    feed += `<p>${self.addAnalyticsToLinks(paragraph.richtext.trim(), publishDate, slug)}</p>`;
                                }
                            }
                        }

                        // handle inline elements (images / videos) - intentionally only grabbing the first item in the array
                        if (paragraph.elements.length > 0) {

                            // handle embeds
                            if (paragraph.elements[0].type === 'embed') {
                                debugLog(paragraph.elements[0]);

                                switch (paragraph.elements[0].attributes.type) {
                                    // case 'twitter':
                                    //     rawEmbed = paragraph.elements[0].attributes.url;
                                    //     // rawEmbed = '<blockquote class="twitter-tweet" data-lang="en"><p lang="en" dir="ltr">&#39;The McDonalds Man&#39; - Kanye West (Boys Don&#39;t Cry - Issue 1) <a href="https://t.co/ZKODOlli1W">pic.twitter.com/ZKODOlli1W</a></p>&mdash; Joey (@JoeyMenson) <a href="https://twitter.com/JoeyMenson/status/767301609512730624">August 21, 2016</a></blockquote> <script async src="//platform.twitter.com/widgets.js" charset="utf-8"></script>';
                                    //     tweetAuthor = rawEmbed.match(/&mdash; (.*)\((.*)\) <a/);
                                    //     tweetAuthorName = tweetAuthor[1] || '';
                                    //     tweetAuthorHandle = tweetAuthor[2] || '';
                                    //     twitterHandle = `<strong>${tweetAuthorName}</strong> ${tweetAuthorHandle}`;
                                    //     tweet = rawEmbed.match(/<p.*?>(.*?)<a/)[1];
                                    //     tweetTimestamp = rawEmbed.match(/<a href=\"https:\/\/twitter.com\/.*>(.*)<\/a>/)[1];
                                    //
                                    //     if (previousEmbedType !== 'twitter') {
                                    //         feed += '<hr class="style-id:twitterContentDivider">';
                                    //     }
                                    //
                                    //     feed += '<p class="style-id:twitterAttribution"><span class="style-id:twitterAttribution">TWITTER</span></p>';
                                    //     feed += `<p class="style-id:twitterHandle"><span class="style-id:twitterHandle">${twitterHandle}</span></p>`;
                                    //     feed += `<p class="style-id:twitterTweet"><span class="style-id:twitterTweet">${tweet}</span></p>`;
                                    //     feed += `<p class="style-id:twitterTimestamp"><span class="style-id:twitterTimestamp">${tweetTimestamp}</span></p>`;
                                    //     feed += '<hr class="style-id:twitterContentDivider">';
                                    //     break;

                                    // case 'facebook':
                                        // need to hand construct and style, which may not be possible with the lack of info we have from our CMS

                                    // case 'instagram':
                                        // this will only work w/ the new oembed code in the CMS
                                        // this will NOT work with the legacy embed code from the CMS

                                        // TODO
                                        // - this SHOULD work (maybe), need to test
                                        // - test that all IG urls end in /?taken-by...
                                        // - find the best way to determine the model is the new oembed model
                                        // contentModel.docs[0].relatedMedia.media.some((item) => {
                                        //     if (item.location === paragraph.id && item.unindexedAttributes.schemaVersion === 2 && item.url) {
                                        //         let igUrl = item.url.replace(/^https:/, '').replace(/\?taken.*$/, 'embed/');
                                        //         feed += `<iframe allowtransparency="true" frameborder="0" height="710" scrolling="no" src="${igUrl}" width="612"></iframe>`;
                                        //         return true;
                                        //     }
                                        // });
                                        // break;

                                    case 'youtube':
                                        feed += `<iframe allowtransparency="true" frameborder="0" height="710" scrolling="no" src="${paragraph.elements[0].attributes.url}" width="612"></iframe>`;
                                        break;

                                    // case 'vimeo':
                                        // Both the vimeo examples I found used webtags :(
                                        // feed += `<iframe allowtransparency="true" frameborder="0" height="710" scrolling="no" src="${paragraph.elements[0].attributes.url}" width="612"></iframe>`;
                                        // break;

                                    case 'vine':
                                        feed += `<iframe allowtransparency="true" frameborder="0" height="710" scrolling="no" src="${paragraph.elements[0].attributes.url}" width="612"></iframe>`;
                                        break;
                                }
                            }

                            // previousEmbedType = paragraph.elements[0].attributes.type;

                            // inline image / video
                            if (paragraph.elements[0].type === 'handle') {
                                // handle inline images
                                if (paragraph.elements[0].target.type === 'image') {
                                    contentModel.docs[0].relatedMedia.media.some((item) => {
                                        if (item.location === paragraph.id) {
                                            let caption = undefined,
                                                imageCut = '';
                                            imageCut = self.cutImage(item);

                                            self.dynaimageUrlsToProcess.push(item.cuts[imageCut].url);

                                            // feed += `<img src="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" height="${item.cuts[imageCut].height}" width="${item.cuts[imageCut].width}"/>`;
                                            feed += `<img src="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}"/>`;

                                            if (item.caption && !item.photographer) {
                                                caption = item.caption;
                                            }

                                            if (!item.caption && item.photographer) {
                                                caption = `<span class="style-id:credit">${item.photographer}</span>`;
                                            }

                                            if (item.caption && item.photographer) {
                                                caption = `${item.caption} <span class="style-id:credit">${item.photographer}</span>`;
                                            }

                                            feed += `<hr class="style-id:relatedContentDivider"><p class="style-id:caption"><span class="style-id:caption">${caption}</span></p>`;

                                            return true;
                                        }
                                    });
                                }

                                // handle inline videos
                                if (paragraph.elements[0].target.type === 'video') {
                                    contentModel.docs[0].relatedMedia.media.some((item) => {
                                        if (item.location === paragraph.id) {
                                            let fullCaption = undefined,
                                                caption = undefined,
                                                imageCut = '';
                                            imageCut = self.cutImage(item);

                                            self.dynaimageUrlsToProcess.push(item.cuts[imageCut].url);

                                            feed += `<video src="${item.cdnUrls['1280x720_3500k_mp4']}" poster="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}"></video>`;

                                            if (paragraph.elements[0].attributes.caption) {
                                                caption = paragraph.elements[0].attributes.caption.trim();
                                            }

                                            if (item.title && !caption && !item.source) {
                                                fullCaption = item.title;
                                            }

                                            if (item.title && caption && !item.source) {
                                                fullCaption = `${item.title} - ${caption}`;
                                            }

                                            if (!item.title && !caption && item.source) {
                                                fullCaption = `<span class="style-id:credit">${item.source}</span>`;
                                            }

                                            if (item.title && !caption && item.source) {
                                                fullCaption = `${item.title} <span class="style-id:credit">${item.source}</span>`;
                                            }

                                            if (!item.title && caption && item.source) {
                                                fullCaption = `${caption} <span class="style-id:credit">${item.source}</span>`;
                                            }

                                            if (item.title && caption && item.source) {
                                                fullCaption = `${item.title} - ${caption} <span class="style-id:credit">${item.source}</span>`;
                                            }

                                            if (fullCaption) {
                                                feed += `<hr class="style-id:relatedContentDivider"><p class="style-id:caption"><span class="style-id:caption"><strong>Video</strong> ${fullCaption}</span></p>`;
                                            }

                                            return true;
                                        }
                                    });
                                }
                            }
                        }
                    });

                    feed += `<p class="style-id:footer"><span class="style-id:copyright">&copy;${new Date().getFullYear()} Cable News Network, Inc. A Time Warner Company. All Rights Reserved.</span></p>`;
                    feed += ']]></content:encoded>';
                }

                // /* PROCESS CONTENT WITH TYPE === GALLERY */
                // if (contentModel.docs[0].type === 'gallery') {
                //     contentModel.docs[0].slides.forEach((slide) => {
                //         let description = slide.caption[0].plaintext || undefined;
                //
                //         if (slide.headline) {
                //             if (description) {
                //                 description = `${slide.headline} - ${description}`;
                //             } else {
                //                 description = slide.headline;
                //             }
                //         }
                //
                //         feed += `<media:content url="${slide.image.url}">`;
                //
                //         if (description) {
                //             feed += `<media:description type="plain"><![CDATA[${description}]]></media:description>`;
                //         }
                //
                //         if (slide.credit) {
                //             feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${slide.credit}]]></media:credit>`;
                //         }
                //
                //         feed += '</media:content>';
                //     });
                // }

                /* PROCESS CONTENT WITH TYPE === VIDEO */
                if (contentModel.docs[0].type === 'video') {
                    feed += `<media:content url="${contentModel.docs[0].cdnUrls['1920x1080_5500k_mp4']}" medium="video">`;
                    feed += `<media:title>${contentModel.docs[0].headline}</media:title>`;
                    feed += `<media:description><![CDATA[${self.addAnalyticsToLinks(contentModel.docs[0].description[0].richtext, publishDate, slug)}]]></media:description>`;
                    feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${contentModel.docs[0].source}]]></media:credit>`;

                    contentModel.docs[0].relatedMedia.media.some((item) => {
                        if (item.type === 'image' && item.location === 'thumbnails') {
                            let imageCut = self.cutImage(item);

                            self.dynaimageUrlsToProcess.push(item.cuts[imageCut].url);

                            // feed += `<media:thumbnail url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" height="${item.cuts[imageCut].height}" width="${item.cuts[imageCut].width}" />`;
                            feed += `<media:thumbnail url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}"/>`;
                            return true;
                        }
                    });

                    feed += '</media:content>';

                    feed += '<content:encoded><![CDATA[';
                    feed += `<meta itemprop="genre" content="${contentModel.docs[0].section}"/>`;

                    if (contentModel.docs[0].lastPublishDate !== contentModel.docs[0].firstPublishDate) {
                        feed += `<meta itemprop="datePublished" content="Updated ${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                    } else {
                        feed += `<meta itemprop="datePublished" content="${moment(contentModel.docs[0].lastPublishDate).tz('America/New_York').format('h:mm A z MMMM D, YYYY')}"/>`;
                    }

                    feed += `<p class="style-id:mediaFirstParagraph"><span class="style-id:mediaFirstParagraphText">${self.addAnalyticsToLinks(contentModel.docs[0].description[0].richtext, publishDate, slug)}</span></p>`;
                    feed += `<p class="style-id:mediaFooter"><span class="style-id:mediaCopyright">&copy;${new Date().getFullYear()} Cable News Network, Inc. A Time Warner Company. All Rights Reserved.</span></p>`;
                    feed += ']]></content:encoded>';
                }

                feed += '</item>';
            });

            feed += '</channel>';
            feed += '</rss>';

            resolve(feed);
        });
    }



    /**
     * Checks if the url is on the blacklist.
     *
     * @private
     *
     * @param {String} url
     * The url to check.
     *
     * @returns {Boolean}
     */
    isOnBlacklist(url) {
        return this.blacklist.some((regexp) => {
            return regexp.test(url);
        });
    }



    /**
     * Processes the content, aka the array of urls that are set on instantition
     *
     * @returns {Promise}
     */
    processContent() {
        const self = this,
            debugLog = debug('cnn-google-newsstand:FeedGenerator:processContent');

        return new Promise((resolve, reject) => {
            let contentModels = [];

            async.each(this.urls, (url, asyncCallback) => {
                let contentRetriever = new ContentRetriever(url),
                    skip = false;

                contentRetriever.getBaseContentModel().then((baseModel) => {
                    contentRetriever.getRelatedContent(baseModel).then((resolvedModel) => {
                        // if the page top media is a gallery, do not add to the contentModels
                        resolvedModel.docs[0].relatedMedia.media.some((media) => {
                            if (media.location === 'pageTop' && media.type === 'reference' && media.referenceType === 'gallery') {
                                skip = true;
                                return true; // this returns out of the media.some() loop
                            }
                        });

                        if (!skip) {
                            contentModels.push(resolvedModel);
                            debugLog(`Getting resolved model for: ${resolvedModel.docs[0].url}`);
                        }

                        debugLog(`SKIPPING - page top gallery: ${resolvedModel.docs[0].url}`);

                        asyncCallback();
                    });
                });
            },
            (error) => {
                if (error) {
                    reject(error);
                }

                self.generateFeed(contentModels).then(
                    function success(rssFeed) {

                        function processImages(imageUrls) {
                            return new Promise((resolve) => {
                                async.each(imageUrls, (imageUrl, asyncCallback2) => {
                                    imageUrl = imageUrl.replace(/\-super\-169/, '').replace(/\-live\-video/, '');

                                    request.post({
                                        url: ' http://dynaimage-node.prod.services.ec2.dmtio.net/api/v1/asset/register',
                                        json: {
                                            publishingSystemCD: 'gns',
                                            originalAssetURL: imageUrl,
                                            rewritePath: 'gns',
                                            tags: ['gns'],
                                            allowOverwrite: true
                                        },
                                        timeout: 1000 * 5
                                    }, (error, response, body) => {
                                        if (error) {
                                            console.error(`Error processImages: ${JSON.stringify(error)}`);
                                        } else {
                                            if (response.statusCode === 200) {
                                                console.log(`SUCCESSFUL processing: ${body.payload.servingURI}`);
                                            } else {
                                                console.error(`Error in processImages: ${error} with status code ${response.statusCode}`);
                                            }
                                            asyncCallback2();
                                        }
                                    });
                                    console.log(`processed ${imageUrl}`);
                                },
                                (error) => {
                                    if (error) {
                                        console.log(error);
                                    } else {
                                        console.log('done');
                                        resolve();
                                    }
                                });
                            });
                        }

                        processImages(self.dynaimageUrlsToProcess).then(() => {
                            resolve(rssFeed);
                        });
                    },
                    function failure(error) {
                        reject(error);
                    }
                );
            });
        });
    }
}

module.exports = FeedGenerator;
