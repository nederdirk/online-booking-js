/**********************************
*  Recras Online Booking library  *
*  v 0.7.2                        *
**********************************/

class RecrasBooking {
    constructor(options = {}) {
        this.datePicker = null;

        this.PAYMENT_DIRECT = 'mollie';
        this.PAYMENT_AFTERWARDS = 'factuur';

        this.languageHelper = new RecrasLanguageHelper();

        if ((options instanceof RecrasOptions) === false) {
            throw new Error(this.languageHelper.translate('ERR_OPTIONS_INVALID'));
        }
        this.options = options;

        let optionsPromise = this.languageHelper.setOptions(options);

        this.element = this.options.getElement();
        this.element.classList.add('recras-onlinebooking');

        this.fetchJson = url => RecrasHttpHelper.fetchJson(url, this.error);
        this.postJson = (url, data) => RecrasHttpHelper.postJson(this.options.getApiBase() + url, data, this.error);

        if (this.options.getLocale()) {
            if (!RecrasLanguageHelper.isValid(this.options.getLocale())) {
                console.warn(this.languageHelper.translate('ERR_INVALID_LOCALE', {
                    LOCALES: RecrasLanguageHelper.validLocales.join(', '),
                }));
            } else {
                this.languageHelper.setLocale(this.options.getLocale());
            }
        }

        RecrasCSSHelper.loadCSS(RecrasCSSHelper.cssGlobal());
        RecrasCSSHelper.loadCSS(RecrasCSSHelper.cssBooking());
        this.clearAll();

        this.loadingIndicatorShow(this.element);
        optionsPromise
            .then(() => RecrasCalendarHelper.loadScript())
            .then(() => this.getTexts())
            .then(texts => {
                this.texts = texts;
                return this.getPackages();
            }).then(packages => {
                this.loadingIndicatorHide();
                if (this.options.getPackageId()) {
                    this.changePackage(this.options.getPackageId());
                } else {
                    this.showPackages(packages);
                }
            });
    }

    amountsValid(pack) {
        let hasAtLeastOneProduct = false;
        this.getLinesNoBookingSize(pack).forEach(line => {
            let aantal = this.findElement(`[data-package-id="${ line.id }"]`).value;
            if (aantal > 0) {
                hasAtLeastOneProduct = true;
            }
            if (aantal > 0 && aantal < line.aantal_personen) {
                return false;
            }
        });
        if (this.shouldShowBookingSize(pack) && this.bookingSize() > 0) {
            hasAtLeastOneProduct = true;
        }
        return hasAtLeastOneProduct;
    }

    appendHtml(msg) {
        this.element.insertAdjacentHTML('beforeend', msg);
    }

    applyVoucher(packageID, voucherCode) {
        let statusEl = this.findElement('.voucher-status');
        if (statusEl) {
            statusEl.innerHTML = '';
        } else {
            this.element.querySelector('.recras-vouchers').insertAdjacentHTML('beforeend', `<span class="voucher-status"></span>`);
            statusEl = this.findElement('.voucher-status');
        }

        if (!voucherCode) {
            statusEl.innerHTML = this.languageHelper.translate('VOUCHER_EMPTY');
            statusEl.innerHTML= this.languageHelper.translate('VOUCHER_EMPTY');
            return false;
        }
        if (this.appliedVouchers[voucherCode]) {
            statusEl.innerHTML = this.languageHelper.translate('VOUCHER_ALREADY_APPLIED');
            return false;
        }
        let date = this.findElement('.recras-onlinebooking-date').value;
        if (isNaN(Date.parse(date))) {
            statusEl.innerHTML = this.languageHelper.translate('DATE_INVALID');
            return false;
        }

        this.postJson('onlineboeking/controleervoucher', {
            arrangement_id: packageID,
            datum: RecrasDateHelper.datePartOnly(new Date(date)),
            producten: this.productCounts(),
            vouchers: [voucherCode],
        }).then(json => {
            let result = json[voucherCode];
            if (!result.valid) {
                statusEl.innerHTML = this.languageHelper.translate('VOUCHER_INVALID');
                return false;
            }

            this.appliedVouchers[voucherCode] = result.processed;
            this.showTotalPrice();

            statusEl.innerHTML = this.languageHelper.translate('VOUCHER_APPLIED');
        });
    }

    bookingSize() {
        let bookingSizeEl = this.findElement('.bookingsize');
        if (!bookingSizeEl) {
            return 0;
        }
        return parseInt(bookingSizeEl.value, 10);
    }

    bookingSizeLines(pack) {
        return pack.regels.filter(line => {
            return line.onlineboeking_aantalbepalingsmethode === 'boekingsgrootte';
        });
    }

    bookingSizePrice(pack) {
        let lines = this.bookingSizeLines(pack);
        return lines.reduce((acc, line) => {
            return line.product.verkoop + acc;
        }, 0);
    }

    changePackage(packageID) {
        let selectedPackage = this.packages.filter(p => {
            return p.id === packageID;
        });

        this.appliedVouchers = {};
        this.discount = null;

        if (selectedPackage.length === 0) {
            // Reset form
            this.selectedPackage = null;
            this.clearAll();
            this.showPackages(this.packages);
            RecrasEventHelper.sendEvent('Recras:Booking:Reset');
            return false;
        } else {
            this.clearAllExceptPackageSelection();
            RecrasEventHelper.sendEvent('Recras:Booking:PackageChanged');
        }
        this.selectedPackage = selectedPackage[0];
        this.showProducts(this.selectedPackage).then(() => {
            RecrasEventHelper.sendEvent('Recras:Booking:ProductsShown');
            let scrollOptions = {
                behavior: 'smooth',
            };
            if (!('scrollBehavior' in document.documentElement.style)) {
                scrollOptions = true;
            }
            this.findElement('.recras-amountsform').scrollIntoView(scrollOptions);

            this.checkDependencies();
            this.loadingIndicatorShow(this.findElement('.recras-amountsform'));
            return this.showDateTimeSelection(this.selectedPackage);
        }).then(() => {
            this.loadingIndicatorHide();
            this.showContactForm(this.selectedPackage);
        });
    }

    checkDependencies() {
        [...this.findElements('.recras-product-dependency')].forEach(el => {
            el.parentNode.removeChild(el);
        });
        this.requiresProduct = false;

        this.productCounts().forEach(line => {
            if (line.aantal > 0) {
                let packageLineID = line.arrangementsregel_id;
                let product = this.findProduct(packageLineID).product;
                product.vereist_product.forEach(vp => {
                    if (!this.dependencySatisfied(line.aantal, vp)) {
                        this.requiresProduct = true;
                        let requiredAmount = this.requiredAmount(line.aantal, vp);
                        let requiredProductName = this.getProductByID(vp.vereist_product_id).weergavenaam;
                        let message = this.languageHelper.translate('PRODUCT_REQUIRED', {
                            NUM: line.aantal,
                            PRODUCT: product.weergavenaam,
                            REQUIRED_AMOUNT: requiredAmount,
                            REQUIRED_PRODUCT: requiredProductName,
                        });
                        this.findElement('.recras-amountsform').insertAdjacentHTML('beforeend', `<span class="recras-product-dependency">${ message }</span>`);
                    }
                });
            }
        });

        this.maybeDisableBookButton();
    }

    checkDiscountcode(packageID, date, code) {
        let statusEl = this.findElement('.discount-status');
        if (statusEl) {
            statusEl.parentNode.removeChild(statusEl);
        }
        return this.fetchJson(this.options.getApiBase() + 'onlineboeking/controleerkortingscode?datum=' + date + '&arrangement=' + packageID + '&kortingscode=' + code)
            .then(discount => {
                if (discount === false) {
                    this.findElement('.recras-discountcode').insertAdjacentHTML('beforeend', `<span class="discount-status">${ this.languageHelper.translate('DISCOUNT_INVALID') }</span>`);
                    return;
                }
                discount.code = code;
                this.discount = discount;

                this.showTotalPrice();
            });
    }

    checkMaximumAmounts() {
        [...this.findElements('.maximum-amount')].forEach(el => {
            el.parentNode.removeChild(el);
        });

        const maxPerLine = this.selectedPackage.maximum_aantal_personen_online;
        if (maxPerLine === null) {
            return;
        }

        let showWarning = false;
        let selectedProducts = this.productCounts();
        this.languageHelper.filterTags(this.texts.maximum_aantal_online_boeking_overschreden, this.selectedPackage ? this.selectedPackage.id : null).then(msg => {
            selectedProducts.forEach(p => {
                if (p.aantal > maxPerLine && !showWarning) {
                    this.findElement('.recras-amountsform').insertAdjacentHTML('beforeend', `<span class="maximum-amount">${ msg }</span>`);
                    showWarning = true;
                }
            });
        });

    }
    checkMinimumAmounts() {
        [...this.findElements('.minimum-amount')].forEach(el => {
            el.parentNode.removeChild(el);
        });

        let selectedProducts = this.productCounts();
        for (let i = 0; i < selectedProducts.length; i++) {
            let product = selectedProducts[i];
            if (product.aantal < 1) {
                continue;
            }

            let packageLineID = product.arrangementsregel_id;
            let packageLine = this.findProduct(packageLineID);
            if (product.aantal >= packageLine.aantal_personen) {
                continue;
            }

            let input = this.findElement(`[data-package-id="${ packageLineID }"]`);
            if (!input) {
                // This is a "booking size" line - which has no minimum amount
                continue;
            }

            let warnEl = document.createElement('span');
            warnEl.classList.add('minimum-amount');
            warnEl.innerHTML = this.languageHelper.translate('PRODUCT_MINIMUM', {
                MINIMUM: packageLine.aantal_personen,
            });

            let label = this.findElement(`label[for="${ input.id }"]`);
            label.parentNode.appendChild(warnEl);
        }
    }

    clearAll() {
        this.clearElements(this.element.children);
    }

    clearAllExceptPackageSelection() {
        let elements = document.querySelectorAll('#' + this.element.id + ' > *:not(.recras-package-select)');
        this.clearElements(elements);
    }

    clearElements(elements) {
        if (this.datePicker) {
            this.datePicker.destroy();
        }
        this.availableDays = [];
        [...elements].forEach(el => {
            el.parentNode.removeChild(el);
        });
        this.appendHtml(`<div class="latestError"></div>`);
    }

    dependencySatisfied(hasNow, requiredProduct) {
        let productLines = this.productCounts();
        for (let i = 0; i < productLines.length; i++) {
            let line = productLines[i];
            if (line.aantal === 0) {
                continue;
            }

            let product = this.findProduct(line.arrangementsregel_id).product;
            if (product.id !== parseInt(requiredProduct.vereist_product_id, 10)) {
                continue;
            }

            let requiredAmount = this.requiredAmount(hasNow, requiredProduct);

            return line.aantal >= requiredAmount;
        }
        return false;
    }

    error(msg) {
        this.loadingIndicatorHide().bind(this);
        this.findElement('.latestError').innerHTML = `<strong>{ this.languageHelper.translate('ERR_GENERAL') }</strong><p>${ msg }</p>`;
    }

    findElement(querystring) {
        return this.element.querySelector(querystring);
    }

    findElements(querystring) {
        return this.element.querySelectorAll(querystring);
    }

    findProduct(packageLineID) {
        return this.selectedPackage.regels.filter(line => (line.id === packageLineID))[0];
    }

    formatPrice(price) {
        return this.languageHelper.formatPrice(price);
    }

    getAvailableDays(packageID, begin, end) {
        return this.postJson('onlineboeking/beschikbaredagen', {
            arrangement_id: packageID,
            begin: RecrasDateHelper.datePartOnly(begin),
            eind: RecrasDateHelper.datePartOnly(end),
            producten: this.productCounts(),
        }).then(json => {
            this.availableDays = this.availableDays.concat(json);
            return this.availableDays;
        });
    }

    getAvailableTimes(packageID, date) {
        return this.postJson('onlineboeking/beschikbaretijden', {
            arrangement_id: packageID,
            datum: RecrasDateHelper.datePartOnly(date),
            producten: this.productCounts(),
        }).then(json => {
            this.availableTimes = json;
            return this.availableTimes;
        });
    }

    getContactFormFields(pack) {
        let contactForm = new RecrasContactForm(this.options);
        return contactForm.fromPackage(pack).then(formFields => {
            this.contactForm = contactForm;
            return formFields;
        });
    }

    getDiscountPrice(discount) {
        if (!discount) {
            return 0;
        }
        return (discount.percentage / 100) * this.getSubTotal() * -1;
    }

    getLinesBookingSize(pack) {
        return pack.regels.filter(line => (line.onlineboeking_aantalbepalingsmethode === 'boekingsgrootte'));
    }

    getLinesNoBookingSize(pack) {
        return pack.regels.filter(line => (line.onlineboeking_aantalbepalingsmethode !== 'boekingsgrootte'));
    }

    getPackages() {
        return this.fetchJson(this.options.getApiBase() + 'arrangementen')
            .then(json => {
                this.packages = json;
                return this.packages;
            });
    }

    getProductByID(id) {
        let products = this.selectedPackage.regels.map(r => r.product);
        return products.filter(p => (p.id === id))[0];
    }

    getSubTotal() {
        let total = 0;
        this.productCounts().forEach(line => {
            let product = this.findProduct(line.arrangementsregel_id).product;
            total += (line.aantal * product.verkoop);
        });
        return total;
    }

    getTexts() {
        const settings = [
            'maximum_aantal_online_boeking_overschreden',
            'online_boeking_betaalkeuze',
            'online_boeking_betaalkeuze_achteraf_titel',
            'online_boeking_betaalkeuze_ideal_titel',
            'online_boeking_step0_text_pre',
            'online_boeking_step0_text_post',
            'online_boeking_step1_text_pre',
            'online_boeking_step1_text_post',
            'online_boeking_step3_text_pre',
            'online_boeking_step3_text_post',
        ];
        let promises = [];
        settings.forEach(setting => {
            promises.push(this.fetchJson(this.options.getApiBase() + 'instellingen/' + setting));
        });
        return Promise.all(promises).then(settings => {
            let texts = {};
            settings.forEach(setting => {
                texts[setting.slug] = setting.waarde;
            });
            return texts;
        });
    }

    getTotalPrice() {
        let total = this.getSubTotal();

        total += this.getDiscountPrice(this.discount);
        total += this.getVouchersPrice();

        return total;
    }

    getVouchersPrice() {
        let voucherPrice = 0;
        Object.values(this.appliedVouchers).forEach(voucher => {
            Object.values(voucher).forEach(line => {
                voucherPrice -= line.aantal * line.prijs_per_stuk;
            });
        });

        return voucherPrice;
    }

    loadingIndicatorHide() {
        [...document.querySelectorAll('.recrasLoadingIndicator')].forEach(el => {
            el.parentNode.removeChild(el);
        });
    }

    loadingIndicatorShow(afterEl) {
        afterEl.insertAdjacentHTML('beforeend', `<span class="recrasLoadingIndicator">${ this.languageHelper.translate('LOADING') }</span>`);
    }

    maybeDisableBookButton() {
        let button = this.findElement('.bookPackage');
        if (!button) {
            return false;
        }

        let bookingDisabledReasons = [];
        if (this.requiresProduct) {
            bookingDisabledReasons.push('BOOKING_DISABLED_REQUIRED_PRODUCT');
        }
        if (!this.amountsValid(this.selectedPackage)) {
            bookingDisabledReasons.push('BOOKING_DISABLED_AMOUNTS_INVALID');
        }
        if (!this.findElement('.recras-onlinebooking-date').value) {
            bookingDisabledReasons.push('BOOKING_DISABLED_INVALID_DATE');
        }
        if (!this.findElement('.recras-onlinebooking-time').value) {
            bookingDisabledReasons.push('BOOKING_DISABLED_INVALID_TIME');
        }
        if (!this.findElement('.recras-contactform').checkValidity()) {
            bookingDisabledReasons.push('BOOKING_DISABLED_CONTACT_FORM_INVALID');
        }

        if (bookingDisabledReasons.length > 0) {
            const reasonsList = bookingDisabledReasons.map(reason => this.languageHelper.translate(reason)).join('<li>');
            this.findElement('#bookingErrors').innerHTML = `<ul><li>${ reasonsList }</ul>`;
            button.setAttribute('disabled', 'disabled');
        } else {
            this.findElement('#bookingErrors').innerHTML = '';
            button.removeAttribute('disabled');
        }
    }

    normaliseDate(date, packageStart, bookingStart) {
        let diffSeconds = (date - packageStart) / 1000;
        let tempDate = new Date(bookingStart.getTime());
        return new Date(tempDate.setSeconds(tempDate.getSeconds() + diffSeconds));
    }

    paymentMethods(pack) {
        let methods = [];
        if (pack.mag_online_geboekt_worden_direct_betalen) {
            methods.push(this.PAYMENT_DIRECT);
        }
        if (pack.mag_online_geboekt_worden_achteraf_betalen) {
            methods.push(this.PAYMENT_AFTERWARDS);
        }
        return methods;
    }

    previewTimes() {
        [...this.findElements('.time-preview')].forEach(el => {
            el.parentNode.removeChild(el);
        });
        if (this.selectedTime) {
            let linesWithTime = this.selectedPackage.regels.filter(line => !!line.begin);
            let linesBegin = linesWithTime.map(line => new Date(line.begin));
            let packageStart = new Date(Math.min(...linesBegin)); // Math.min transforms dates to timestamps

            this.selectedDate = RecrasDateHelper.setTimeForDate(this.selectedDate, this.selectedTime);

            let linesNoBookingSize = this.getLinesNoBookingSize(this.selectedPackage);
            linesNoBookingSize.forEach((line, idx) => {
                let normalisedStart = this.normaliseDate(new Date(line.begin), packageStart, this.selectedDate);
                let normalisedEnd = this.normaliseDate(new Date(line.eind), packageStart, this.selectedDate);
                this.findElement(`label[for="packageline${ idx }"]`).insertAdjacentHTML(
                    'afterbegin',
                    `<span class="time-preview">(${ RecrasDateHelper.timePartOnly(normalisedStart) } – ${ RecrasDateHelper.timePartOnly(normalisedEnd) })</span>`
                );
            });
        }
    }

    productCounts() {
        let counts = [];
        [...this.findElements('[id^="packageline"]')].forEach(line => {
            counts.push({
                aantal: (isNaN(parseInt(line.value)) ? 0 : parseInt(line.value)),
                arrangementsregel_id: parseInt(line.dataset.packageId, 10),
            });
        });
        this.getLinesBookingSize(this.selectedPackage).forEach(line => {
            counts.push({
                aantal: this.bookingSize(),
                arrangementsregel_id: line.id,
            });
        });
        return counts;
    }

    requiredAmount(hasNow, requiredProduct) {
        let requiredAmount = hasNow / requiredProduct.per_x_aantal;
        if (requiredProduct.afronding === 'boven') {
            requiredAmount = Math.ceil(requiredAmount);
        } else {
            requiredAmount = Math.floor(requiredAmount);
        }
        return requiredAmount;
    }

    resetForm() {
        this.changePackage(null);
    }

    setHtml(msg) {
        this.element.innerHTML = msg;
    }

    showStandardAttachments() {
        if (!this.selectedPackage || !this.findElement('.standard-attachments')) {
            return true;
        }

        let attachments = this.standardAttachments(this.selectedPackage);
        let attachmentHtml = ``;
        if (Object.keys(attachments).length) {
            attachmentHtml += `<p><label><input type="checkbox" required>${ this.languageHelper.translate('AGREE_ATTACHMENTS') }</label></p>`;
            attachmentHtml += `<ul>`;
            Object.values(attachments).forEach(attachment => {
                attachmentHtml += `<li><a href="${ attachment.filename }" download target="_blank">${ attachment.naam }</a></li>`;
            });
            attachmentHtml += `</ul>`;
        }
        this.findElement('.standard-attachments').innerHTML = attachmentHtml;
    }

    showTotalPrice() {
        [...this.findElements('.discountLine, .voucherLine, .priceTotal')].forEach(el => {
            el.parentNode.removeChild(el);
        });

        let html = ``;

        if (this.discount) {
            html += `<div class="discountLine"><div>${ this.discount.naam }</div><div>${ this.formatPrice(this.getDiscountPrice(this.discount)) }</div></div>`;
        }
        if (Object.keys(this.appliedVouchers).length) {
            html += `<div class="voucherLine"><div>${ this.languageHelper.translate('VOUCHERS_DISCOUNT') }</div><div>${ this.formatPrice(this.getVouchersPrice()) }</div></div>`;
        }
        if (this.discount || Object.keys(this.appliedVouchers).length) {
            html += `<div class="priceTotal"><div>${ this.languageHelper.translate('PRICE_TOTAL_WITH_DISCOUNT') }</div><div>${ this.formatPrice(this.getTotalPrice()) }</div></div>`;
        }

        this.findElement('.priceLine').parentElement.insertAdjacentHTML('beforeend', html);
        this.findElement('.priceSubtotal').innerHTML = this.formatPrice(this.getSubTotal());
    }

    sortPackages(packages) {
        // Packages from the API are sorted by internal name, not by display name
        // However, display name is not required so fallback to internal name
        return packages.sort((a, b) => {
            let aName = a.weergavenaam || a.arrangement;
            let bName = b.weergavenaam || b.arrangement;
            if (aName < bName) {
                return -1;
            }
            if (aName > bName) {
                return 1;
            }
            return 0;
        });
    }

    shouldShowBookingSize(pack) {
        return this.bookingSizeLines(pack).length > 0;
    }

    showBookButton() {
        let promises = [];
        let paymentMethods = this.paymentMethods(this.selectedPackage);
        let paymentText = '';
        let textPostBooking = '';
        if (paymentMethods.indexOf(this.PAYMENT_DIRECT) > -1 && paymentMethods.indexOf(this.PAYMENT_AFTERWARDS) > -1) {
            // Let user decide how to pay
            promises.push(this.languageHelper.filterTags(this.texts.online_boeking_betaalkeuze, this.selectedPackage ? this.selectedPackage.id : null));
            promises.push(this.languageHelper.filterTags(this.texts.online_boeking_betaalkeuze_ideal_titel, this.selectedPackage ? this.selectedPackage.id : null));
            promises.push(this.languageHelper.filterTags(this.texts.online_boeking_betaalkeuze_achteraf_titel, this.selectedPackage ? this.selectedPackage.id : null));

            Promise.all(promises).then(msgs => {
                paymentText = `<p>${ msgs[0] }</p>`;
                paymentText += `<ul>
                <li><label><input type="radio" name="paymentMethod" checked value="${ this.PAYMENT_DIRECT }"> ${ msgs[1] }</label>
                <li><label><input type="radio" name="paymentMethod" value="${ this.PAYMENT_AFTERWARDS }"> ${ msgs[2] }</label>
            </ul>`;
            });
        } else {
            // One fixed choice
            promises.push(Promise.resolve(''));
        }
        promises.push(this.languageHelper.filterTags(this.texts.online_boeking_step3_text_post, this.selectedPackage ? this.selectedPackage.id : null).then(msg => {
            textPostBooking = msg;
        }));

        Promise.all(promises).then(() => {
            let html = `<div>
            <p>${ textPostBooking }</p>
            <div class="standard-attachments"></div>
            ${ paymentText }
            <button type="submit" class="bookPackage" disabled>${ this.languageHelper.translate('BUTTON_BOOK_NOW') }</button>
            <div class="booking-error" id="bookingErrors"></div>
        </div>`;
            this.appendHtml(html);
            this.findElement('.bookPackage').addEventListener('click', this.submitBooking.bind(this));
        });
    }

    showDiscountFields() {
        [...this.findElements('.recras-discountcode, .recras-vouchers')].forEach(el => {
            el.parentNode.removeChild(el);
        });

        let html = `
            <div class="recras-discountcode">
                <label for="discountcode">${ this.languageHelper.translate('DISCOUNT_CODE') }</label>
                <input type="text" id="discountcode" class="discountcode" maxlength="50">
                <button>${ this.languageHelper.translate('DISCOUNT_CHECK') }</button>
            </div>
            <div class="recras-vouchers">
                <div>
                    <label for="voucher">${ this.languageHelper.translate('VOUCHER') }</label>
                    <input type="text" class="voucher" maxlength="50">
                    <button>${ this.languageHelper.translate('VOUCHER_APPLY') }</button>
                </div>
            </div>
        `;
        this.findElement('.recras-contactform').insertAdjacentHTML('beforebegin', html);

        this.findElement('.recras-discountcode > button').addEventListener('click', () => {
            this.checkDiscountcode(
                this.selectedPackage.id,
                this.findElement('.recras-onlinebooking-date').value,
                this.findElement('.discountcode').value
            );
        });
        this.findElement('.recras-vouchers button').addEventListener('click', e => {
            this.applyVoucher(this.selectedPackage.id, e.srcElement.parentElement.querySelector('input').value.trim());
        });
    }

    showContactForm(pack) {
        this.loadingIndicatorShow(this.findElement('.recras-datetime'));
        this.getContactFormFields(pack).then(fields => {
            let waitFor = [];

            let hasCountryField = fields.filter(field => {
                return field.field_identifier === 'contact.landcode';
            }).length > 0;

            if (hasCountryField) {
                waitFor.push(this.contactForm.getCountryList());
            }
            Promise.all(waitFor).then(() => {
                let html = '<form class="recras-contactform">';
                fields.forEach((field, idx) => {
                    html += '<div>' + this.contactForm.showField(field, idx) + '</div>';
                });
                html += '</form>';
                this.appendHtml(html);
                this.loadingIndicatorHide();
                this.showBookButton();
                RecrasEventHelper.sendEvent('Recras:Booking:ContactFormShown');

                [...this.findElements('[id^="contactformulier-"]')].forEach(el => {
                    el.addEventListener('change', this.maybeDisableBookButton.bind(this));
                });
            });
        });
    }

    showDateTimeSelection(pack) {
        let startDate = new Date();
        let endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 3);

        return this.getAvailableDays(pack.id, startDate, endDate)
            .then(() => {
                let today = RecrasDateHelper.datePartOnly(new Date());
                let html = `<div class="recras-datetime">`;
                html += `<label for="recras-onlinebooking-date">${ this.languageHelper.translate('DATE') }</label><input type="text" id="recras-onlinebooking-date" class="recras-onlinebooking-date" min="${ today }" disabled>`;
                html += `<label for="recras-onlinebooking-time">${ this.languageHelper.translate('TIME') }</label><select id="recras-onlinebooking-time" class="recras-onlinebooking-time" disabled></select>`;
                html += '</div>';
                this.appendHtml(html);
                let pikadayOptions = Object.assign(
                    RecrasCalendarHelper.defaultOptions(),
                    {
                        disableDayFn: (day) => {
                            let dateFmt = RecrasDateHelper.datePartOnly(day);
                            return this.availableDays.indexOf(dateFmt) === -1;
                        },
                        field: this.findElement('.recras-onlinebooking-date'),
                        i18n: RecrasCalendarHelper.i18n(this.languageHelper),
                        onDraw: (pika) => {
                            let lastMonthYear = pika.calendars[pika.calendars.length - 1];
                            let lastDay = new Date(lastMonthYear.year, lastMonthYear.month, 31);

                            let lastAvailableDay = this.availableDays.reduce((acc, curVal) => {
                                return curVal > acc ? curVal : acc;
                            }, '');
                            if (!lastAvailableDay) {
                                lastAvailableDay = new Date();
                            } else {
                                lastAvailableDay = new Date(lastAvailableDay);
                            }
                            if (lastAvailableDay > lastDay) {
                                return;
                            }

                            let newEndDate = RecrasDateHelper.clone(lastAvailableDay);
                            newEndDate.setFullYear(lastMonthYear.year);
                            newEndDate.setMonth(lastMonthYear.month + 2);

                            this.getAvailableDays(pack.id, lastAvailableDay, newEndDate);
                        },
                        onSelect: (date) => {
                            RecrasEventHelper.sendEvent('Recras:Booking:DateSelected');
                            this.selectedDate = date;
                            this.getAvailableTimes(pack.id, date).then(times => {
                                times = times.map(time => RecrasDateHelper.timePartOnly(new Date(time)));
                                this.showTimes(times);
                            });
                            this.maybeDisableBookButton();
                            this.showDiscountFields();
                        },
                    }
                );

                this.datePicker = new Pikaday(pikadayOptions);

                this.findElement('.recras-onlinebooking-time').addEventListener('change', () => {
                    RecrasEventHelper.sendEvent('Recras:Booking:TimeSelected');
                    this.selectedTime = this.findElement('.recras-onlinebooking-time').value;
                    this.previewTimes();
                    this.maybeDisableBookButton();
                });
            });
    }

    showPackages(packages) {
        packages = packages.filter(p => {
            return p.mag_online;
        });
        let packagesSorted = this.sortPackages(packages);
        let packageOptions = packagesSorted.map(pack => `<option value="${ pack.id }">${ pack.weergavenaam || pack.arrangement }`);

        let html = '<select class="recras-package-selection"><option>' + packageOptions.join('') + '</select>';
        let promises = [];
        promises.push(this.languageHelper.filterTags(this.texts.online_boeking_step0_text_pre, this.selectedPackage ? this.selectedPackage.id : null));
        promises.push(this.languageHelper.filterTags(this.texts.online_boeking_step0_text_post, this.selectedPackage ? this.selectedPackage.id : null));
        Promise.all(promises).then(msgs => {
            this.appendHtml(`<div class="recras-package-select"><p>${ msgs[0] }</p>${ html }<p>${ msgs[1] }</p></div>`);
            RecrasEventHelper.sendEvent('Recras:Booking:PackagesShown');

            let packageSelectEl = this.findElement('.recras-package-selection');
            packageSelectEl.addEventListener('change', () => {
                let selectedPackageId = parseInt(packageSelectEl.value, 10);
                this.changePackage(selectedPackageId);
            });
        });
    }

    showProducts(pack) {
        let promises = [];
        promises.push(this.languageHelper.filterTags(this.texts.online_boeking_step1_text_pre, this.selectedPackage ? this.selectedPackage.id : null));
        promises.push(this.languageHelper.filterTags(this.texts.online_boeking_step1_text_post, this.selectedPackage ? this.selectedPackage.id : null));

        return Promise.all(promises).then(msgs => {
            let html = '<div class="recras-amountsform">';
            html += `<p>${ msgs[0] }</p>`;

            if (this.shouldShowBookingSize(pack)) {
                html += `<div>`;
                html += `<div><label for="bookingsize">${ (pack.weergavenaam || pack.arrangement) }</label></div>`;
                html += `<input type="number" id="bookingsize" class="bookingsize" min="0">`;
                html += `<div class="recras-price">${ this.formatPrice(this.bookingSizePrice(pack)) }</div>`;
                html += `</div>`;
            }

            let linesNoBookingSize = this.getLinesNoBookingSize(pack);
            linesNoBookingSize.forEach((line, idx) => {
                html += '<div><div>';
                html += `<label for="packageline${ idx }">${ line.beschrijving_templated }</label>`;
                let maxAttr = line.max ? `max="${ line.max }"` : '';
                html += `</div><input id="packageline${ idx }" type="number" min="0" ${ maxAttr } data-package-id="${ line.id }">`;
                html += `<div class="recras-price">${ this.formatPrice(line.product.verkoop) }</div>`;
                html += '</div>';
            });
            html += `<div class="priceLine"><div>${ this.languageHelper.translate('PRICE_TOTAL') }</div><div class="priceSubtotal"></div></div>`;

            html += `<p>${ msgs[1] }</p>`;
            html += '</div>';
            this.appendHtml(html);

            [...this.findElements('[id^="packageline"], .bookingsize')].forEach(el => {
                el.addEventListener('input', this.updateProductAmounts.bind(this));
            });
        });
    }

    showTimes(times) {
        let html = `<option>`;
        times.forEach(time => {
            html += `<option value="${ time }">${ time }`;
        });
        this.findElement('.recras-onlinebooking-time').innerHTML = html;
        this.findElement('.recras-onlinebooking-time').removeAttribute('disabled');
    }

    clearTimes() {
        this.findElement('.recras-onlinebooking-time').innerHTML = '';
        this.findElement('.recras-onlinebooking-time').setAttribute('disabled', 'disabled');
    }

    standardAttachments() {
        let attachments = {};
        this.productCounts().forEach(line => {
            if (line.aantal > 0) {
                let product = this.findProduct(line.arrangementsregel_id).product;
                product.standaardbijlagen.forEach(attachment => {
                    attachments[attachment.id] = attachment;
                });
            }
        });

        return attachments;
    }

    submitBooking() {
        RecrasEventHelper.sendEvent('Recras:Booking:BuyInProgress');
        let productCounts = this.productCounts().map(line => line.aantal);
        let productSum = productCounts.reduce((a, b) => a + b, 0);
        if (this.bookingSize() === 0 && productSum === 0) {
            window.alert(this.languageHelper.translate('NO_PRODUCTS'));
            return false;
        }

        let paymentMethod = this.PAYMENT_DIRECT;
        let paymentMethodEl = this.findElement('[name="paymentMethod"]:checked');
        if (paymentMethodEl && this.validPaymentMethod(this.selectedPackage, paymentMethodEl.value)) {
            paymentMethod = paymentMethodEl.value;
        }

        this.loadingIndicatorHide();
        this.loadingIndicatorShow(this.findElement('.bookPackage'));
        this.findElement('.bookPackage').setAttribute('disabled', 'disabled');

        let vouchers = Object.keys(this.appliedVouchers).length > 0 ? Object.keys(this.appliedVouchers) : null;
        let bookingParams = {
            arrangement_id: this.selectedPackage.id,
            begin: this.selectedDate,
            betaalmethode: paymentMethod,
            contactformulier: this.contactForm.generateJson(),
            kortingscode: (this.discount && this.discount.code) || null,
            producten: this.productCounts(),
            status: null,
            stuur_bevestiging_email: true,
            vouchers: vouchers,
        };
        if (this.shouldShowBookingSize(this.selectedPackage)) {
            bookingParams.boekingsgrootte = this.bookingSize();
        }
        if (this.options.getRedirectUrl()) {
            bookingParams.redirect_url = this.options.getRedirectUrl();
        }

        return this.postJson('onlineboeking/reserveer', bookingParams).then(json => {
            this.loadingIndicatorHide();
            this.findElement('.bookPackage').removeAttribute('disabled');

            if (json.payment_url) {
                window.top.location.href = json.payment_url;
            } else if (json.message && json.status) {
                if (bookingParams.redirect_url) {
                    RecrasEventHelper.sendEvent('Recras:Booking:RedirectToPayment');
                    window.top.location.href = bookingParams.redirect_url;
                } else {
                    window.alert(json.message);
                }
            } else {
                console.log(json);
            }
        });
    }

    updateProductAmounts() {
        this.loadingIndicatorHide();
        this.loadingIndicatorShow(this.findElement('label[for="recras-onlinebooking-date"]'));
        let startDate = new Date();
        let endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 3);

        this.availableDays = [];
        this.getAvailableDays(this.selectedPackage.id, startDate, endDate)
            .then(availableDays => {
                this.loadingIndicatorHide();

                let datePickerEl = this.findElement('.recras-onlinebooking-date');
                if (datePickerEl.value && availableDays.indexOf(datePickerEl.value) === -1) {
                    datePickerEl.value = '';
                    this.clearTimes();
                } else {
                    datePickerEl.removeAttribute('disabled');
                }
            });

        this.checkDependencies();
        this.checkMinimumAmounts();
        this.checkMaximumAmounts();
        this.showTotalPrice();
        this.showStandardAttachments();
    }

    validPaymentMethod(pack, method) {
        return this.paymentMethods(pack).indexOf(method) > -1;
    }
}
