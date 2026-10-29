# hcaptcha-captcha-demo3-webpage

The webpage records parent-page events without an extension. Recording inside
the cross-origin hCaptcha iframes and observing genuine VM snapshots requires
the VMC Chrome extension to be enabled.

The combined extension in **`dist/vmc-frame-observer`** supports these two exact
origins in separate tabs:

- <https://hcaptcha-captcha-demo2-webpage.vercel.app/>
- <https://hcaptcha-captcha-demo3-webpage.vercel.app/>

In `chrome://extensions`, disable the older demo2-only VMC observer, enable
Developer mode, and use **Load unpacked** to choose `dist/vmc-frame-observer`.
Then reload both webpage tabs. One enabled combined extension handles both;
records and exports stay separate by browser tab and experiment origin. You can also download and
unzip [the same package](https://hcaptcha-captcha-demo3-webpage.vercel.app/vmc/vmc-frame-observer-demo2-demo3.zip).

`Iframe observer: N frames · 0 VM snapshots` means the iframe observer is
connected. VM snapshots count actual observed proof calls; merely loading the
registration page does not guarantee a snapshot. `not detected (parent only)`
means no companion extension answered on that page.

The `collector` folder contains the builder, recorder core, bridge, and service
worker sources. The build configuration is
`hcaptcha-captcha-demo-webpage/vmc-config.json`. Rebuild the extension and its
downloadable ZIP, and apply the demo3 webpage's configuration, with:

```sh
python3 hcaptcha-captcha-demo-webpage/scripts/configure-vmc.py
```

Run the scope, bridge, and tab-isolation regression tests with:

```sh
npm test --prefix hcaptcha-captcha-demo-webpage
```
