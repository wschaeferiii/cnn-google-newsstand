#Google Newsstand Technical Debt
######Exisitng TODOs
1 - Handle URLs with query strings in adding analytics to the links (there should be none).


```
addAnalyticsToLinks(text, publishDate, slug) {
    return text.replace(/(<a href="http:\/\/(www|edition).cnn.*?)">(.*?)<\/a>/g, `$1?sr=${publishDate}_${slug}">$3</a>`);
}
```
2 - Image captioning and photo credit underneath page-top images


```
if (item.caption && item.caption.trim()) {
   feed += `<media:description type="plain"><![CDATA[${item.caption}]]></media:description>`;
}

if (item.photographer && item.photographer.trim()) {
	feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${item.photographer}]]></media:credit>`;
}
```
3 - Handle a top gallery (filtered out upstream)

```
if (item.referenceType === "gallery") {
	// code here
}
```

4 - Add logic for missing thumbnails

``` 
feed += `<media:thumbnail url="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '')}" width="${item.cuts[imageCut].width}" height="${item.cuts[imageCut].height}"/>`;
```

5 - Social Embed Links

* Twitter - should work (Google strays away from twitter embeds?)
* Facebook - need to hand construct and style (may not be possible with current CMS info) [facebook docs](https://developers.facebook.com/docs/plugins/embedded-posts)
* Instagram - will only work with the current CMS code, not the legacy version
* Youtube - works
* Vimeo - can't use webtags
* Vine - works

6 - Process Content with Type: "Gallery"

```
if (contentModel.docs[0].type === 'gallery') {
    contentModel.docs[0].slides.forEach((slide) => {
        let description = slide.caption[0].plaintext || undefined;

        if (slide.headline) {
            if (description) {
                description = `${slide.headline} - ${description}`;
            } else {
                description = slide.headline;
            }
        }

        feed += `<media:content url="${slide.image.url}">`;

        if (description) {
            feed += `<media:description type="plain"><![CDATA[${description}]]></media:description>`;
        }

        if (slide.credit) {
            feed += `<media:credit role="author" scheme="urn:ebu"><![CDATA[${slide.credit}]]></media:credit>`;
        }

        feed += '</media:content>';
    });
}
```

######Will's Ideas
1 - Abstract out imageCuts into a function (pull requested)

2 - Add error handling to rabbitmq (pull requested)

3 - article feed-generator task dryed & refactored (pull requested)

4 - Have a 'offline queue' if rabbitMQ goes down and queue can continue to publish once back online

5 - Have `processImage([imageUrls])` contain all logic regarding URL pattern matching

6 - Be able to cut images without get and post to dynaimage

7 - Defensive programming / error handling if images aren't processed

8 - Define height & width for images in rss xml

9 - Noticed the url "`replace`" pattern logic in `processImage([imageUrls])` and in the `generateFeed([contentModels])` :

```
generateFeed(contentModels) {
...
feed += `<img src="${item.cuts[imageCut].url.replace(/i2.cdn.turner.com\/cnnnext\/dam\/assets\//, 'dynaimage.cdn.turner.com/gns/gns/e_trim/').replace(/\-super\-169/, '').replace(/-live-video/, '')}"/>`;
...
```
```
processImage(imageUrls) {
...
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
            },
         	...
```
 	
