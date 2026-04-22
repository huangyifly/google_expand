import json

import requests


URL = "https://agentseller.temu.com/visage-agent-seller/product/add"

HEADERS = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    "anti-content": "0aqWfqvUHjtaj99ZvnuJsxA4ZugDAEM1rCfpkzVKz1D8-Gm54-k_Fxh8McRmFxh_5XlSupw_dgTEnJs379sC2uHlGUt8u3JQUZHfebHJDSzUGgF8xugkb1U-hgax4SQufpYGK8gtDvWfM4QOXXF1vrhOhQdNvS6y3TLws4wewncRqMncGRbwYGBQkpvyLQ-xonLhqxGFVZv_dwnzefPIdFPtzK0nw2gACvOIeNCS8L7SPPdjia5riXmgKDlPQX5IQTA-N_XkHX0yPFk0OBI99XpUPgFp5w3VI19p3PTz75q_3VVTNw02v_LrCnRmaRgfX09aB39IL9jzrJgVcw9oQVpe0IRF3fCkm-Hz0ejGWGlHRYL6n1hXG40mXOPPHCaUmqMnivem-hUPu3Bi7Nko8L8KhtFeNpdosVFMkPPCwVER-ppJH_QyOorYZ2NuciIhSNrSqr_xV7",
    "cache-control": "max-age=0",
    "content-type": "application/json",
    "cookie": "api_uid=CmyEIGnoSVxps6p/M3nyAg==; _nano_fp=GWZoSWicvjZ2v3ZckOZks#GkmcyfGu-A98n5HWRQesR; _bee=8rvxFybwXiDKxFFnil4A3kS7D6Ci5apv; njrpl=8rvxFybwXiDKxFFnil4A3kS7D6Ci5apv; dilx=ygU3zvvBdwfItCmmfsqY4; hfsc=L3yNfoEz6Tb515HKew==; mallid=634418228911214; seller_temp=N_eyJ0IjoiWXZ4WWVTM2twNE9pQXE2WVFma2VOQmtidUJtYWVBaVNVRUpxcEhxUzhGcUVhQTdWNDVQTS8ra3pEeXRZSFlxbGZNdzZOQ2JXekVjdmVUNXpzNXJaZVE9PSIsInYiOjEsInMiOjEwMDAxLCJ1IjozMDczMDYzNjcxNzQ5M30=",
    "mallid": "634418228911214",
    "origin": "https://agentseller.temu.com",
    "priority": "u=1, i",
    "referer": "https://agentseller.temu.com/goods/edit?productDraftId=6237365397&from=productDraftList",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}

PAYLOAD = json.loads(
    r"""{"cat1Id":39316,"cat2Id":39418,"cat3Id":39461,"cat4Id":39465,"cat5Id":0,"cat6Id":0,"cat7Id":0,"cat8Id":0,"cat9Id":0,"cat10Id":0,"materialMultiLanguages":[],"productName":"1卷393.7英寸窗帘缩短胶带——多功能粘合剂，便捷卷装包装，适用于窗帘，经久耐用","productI18nReqs":[{"productName":"1 roll of 393.7-inch curtain shortening tape-multifunctional adhesive, convenient roll packaging, suitable for curtains, durable","language":"en"}],"productPropertyReqs":[{"templatePid":1284008,"pid":13,"refPid":63,"propName":"颜色","vid":376,"propValue":"白色","valueUnit":"","valueExtendInfo":"","numberInputValue":""},{"templatePid":1284254,"pid":89,"refPid":121,"propName":"材料","vid":2148,"propValue":"塑料","valueUnit":"","valueExtendInfo":"","numberInputValue":""},{"templatePid":1284009,"pid":104,"refPid":122,"propName":"表面推荐","vid":3346,"propValue":"玻璃","valueUnit":"","valueExtendInfo":"","numberInputValue":""}],"productSkcReqs":[{"previewImgUrls":["https://img.kwcdn.com/product/open/ac36fea02a484ebbb0d196f22c1e7b94-goods.jpeg"],"productSkcCarouselImageI18nReqs":[],"extCode":"","mainProductSkuSpecReqs":[{"parentSpecId":0,"parentSpecName":"","specId":0,"specName":""}],"productSkuReqs":[{"thumbUrl":"https://img.kwcdn.com/product/open/bf9ee53d66414cdb8f84b66c10cbd550-goods.jpeg","productSkuThumbUrlI18nReqs":[],"extCode":"","supplierPrice":1000,"currencyType":"CNY","productSkuSpecReqs":[{"parentSpecId":15998553,"parentSpecName":"数量","specId":16091728,"specName":"1个"},{"parentSpecId":3001,"parentSpecName":"尺码","specId":287431221,"specName":"2.8厘米*7米/1.1英寸*275.6英寸-1卷"}],"productSkuId":0,"productSkuSuggestedPriceReq":{"suggestedPrice":1000,"suggestedPriceCurrencyType":"USD"},"productSkuUsSuggestedPriceReq":{},"productSkuWhExtAttrReq":{"productSkuVolumeReq":{"len":90,"width":90,"height":90},"productSkuWeightReq":{"value":220000},"productSkuBarCodeReqs":[],"productSkuSensitiveAttrReq":{"isSensitive":0,"sensitiveList":[]},"productSkuSensitiveLimitReq":{}},"productSkuMultiPackReq":{"skuClassification":2,"numberOfPieces":3,"pieceUnitCode":1,"productSkuNetContentReq":{},"totalNetContent":{},"individuallyPacked":0},"productSkuAccessoriesReq":{"productSkuAccessories":[]},"productSkuNonAuditExtAttrReq":{}}],"productSkcId":0,"isBasePlate":0}],"productSpecPropertyReqs":[{"parentSpecId":15998553,"parentSpecName":"数量","specId":16091728,"specName":"1个","vid":0,"refPid":0,"pid":0,"templatePid":0,"propName":"数量","propValue":"1个","valueUnit":"","valueGroupId":0,"valueGroupName":"","valueExtendInfo":""},{"parentSpecId":3001,"parentSpecName":"尺码","specId":287431221,"specName":"2.8厘米*7米/1.1英寸*275.6英寸-1卷","vid":0,"refPid":0,"pid":0,"templatePid":0,"propName":"尺码","propValue":"2.8厘米*7米/1.1英寸*275.6英寸-1卷","valueUnit":"","valueGroupId":0,"valueGroupName":"","valueExtendInfo":""}],"carouselImageUrls":["https://img.kwcdn.com/product/open/ac36fea02a484ebbb0d196f22c1e7b94-goods.jpeg","https://img.kwcdn.com/product/open/64277dda6c8244a69beff8b52097e006-goods.jpeg","https://img.kwcdn.com/product/open/978affc1375d47309912e70dd01f39e3-goods.jpeg","https://img.kwcdn.com/product/open/8cb61e94056d43758f09edb60e2cb928-goods.jpeg","https://img.kwcdn.com/product/open/4e65672ab2174ba2999c8a3709b16473-goods.jpeg","https://img.kwcdn.com/product/open/53b94a0f84d449fe93f27b25b0cb9db7-goods.jpeg","https://img.kwcdn.com/product/open/893df1d87a3d43e2b22c5c3451ce91fd-goods.jpeg","https://img.kwcdn.com/product/open/494c3fe670c841e2b0b26e932a256b3f-goods.jpeg","https://img.kwcdn.com/product/open/84792104a5ee414db7805813c82735aa-goods.jpeg","https://img.kwcdn.com/product/open/d7468f5154784aac88d7edb86d0335d0-goods.jpeg"],"carouselImageI18nReqs":[],"materialImgUrl":"https://img.kwcdn.com/product/open/bf9ee53d66414cdb8f84b66c10cbd550-goods.jpeg","goodsLayerDecorationReqs":[{"floorId":null,"lang":"zh","key":"DecImage","type":"image","priority":0,"contentList":[{"imgUrl":"https://img.kwcdn.com/product/open/893df1d87a3d43e2b22c5c3451ce91fd-goods.jpeg","height":800,"width":800}]},{"floorId":null,"lang":"zh","key":"DecImage","type":"image","priority":1,"contentList":[{"imgUrl":"https://img.kwcdn.com/product/open/f4b9ad3cee2547a59613aee10bedb57c-goods.jpeg","height":800,"width":800}]},{"floorId":null,"lang":"zh","key":"DecImage","type":"image","priority":2,"contentList":[{"imgUrl":"https://img.kwcdn.com/product/open/51b1c0ca616149e985c85b0890289d63-goods.jpeg","height":800,"width":800}]},{"floorId":null,"lang":"zh","key":"DecImage","type":"image","priority":3,"contentList":[{"imgUrl":"https://img.kwcdn.com/product/open/162246dfc8b44f8d8857ff518dd57043-goods.jpeg","height":800,"width":800}]}],"goodsLayerDecorationCustomizeI18nReqs":[],"sizeTemplateIds":[],"showSizeTemplateIds":[],"goodsModelReqs":[],"productWhExtAttrReq":{"outerGoodsUrl":"","productOrigin":{"countryShortName":"CN","region2Id":43000000000006}},"productCarouseVideoReqList":[],"goodsAdvantageLabelTypes":[],"productDetailVideoReqList":[],"productOuterPackageImageReqs":[{"imageUrl":"https://pfs.file.temu.com/product-material-private-tag/21140d64ad0/d6b71510-7b0d-402c-b4a4-1c12cbe2e051_300x300.jpeg"}],"productOuterPackageReq":{"packageShape":0,"packageType":0},"sensitiveTransNormalFileReqs":[],"productGuideFileNewReqList":[],"productGuideFileI18nReqs":[],"productSaleExtAttrReq":{"bodyShape":null},"productNonAuditExtAttrReq":{"california65WarningInfoReq":{"california65WarningType":null,"california65ChemicalNames":null},"cosmeticInfoReq":{}},"personalizationSwitch":0,"productComplianceStatementReq":{"protocolVersion":"V2.0","protocolUrl":"https://dl.kwcdn.com/seller-public-file-us-tag/2079f603b6/56888d17d8166a6700c9f3e82972e813.html"},"productOriginCertFileReqs":[],"productDraftId":6237365397}"""
)


def main() -> None:
    response = requests.post(URL, headers=HEADERS, json=PAYLOAD, timeout=30)
    print("status:", response.status_code)
    print("text:", response.text)


if __name__ == "__main__":
    main()
