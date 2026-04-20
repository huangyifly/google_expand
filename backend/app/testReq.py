import requests

url = "https://plugin.newmorehot.com/v1/temu2/productList"

headers = {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Connection": "keep-alive",
    "Origin": "chrome-extension://iempaihdolnjigkhhjghnbkpdmfmhajn",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Storage-Access": "active",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "content-type": "application/json",
    "crx-fid": "cbce60a1606be0a7ba30d5612dc3189f",
    "crx-id": "iempaihdolnjigkhhjghnbkpdmfmhajn",
    "crx-v": "0.0.8",
    "region": "37",
}

cookies = {
    "PHPSESSID": "902f2735fccbf9f140c0086f4837cf4f"
}

json_data = {
    "goods": "Vc05DsIADETRu7hOMd7GNldB6WgoqCgRdyeRWEL79EfzkOvlLqezEIoZZlRV0GTZRQFXs4SSX2l2dSJ+TaMi0NYfUW/HtjKVdZHb+8LoGRNJ+tSeeoS2adPY6gcZ5JbFnxhq5iDOzDLI+nwB",
    "referer": "https://www.temu.com/ca/channel/best-sellers.html?filter_items=1%3A1&scene=home_title_bar_recommend&refer_page_el_sn=201341&refer_page_name=home&refer_page_id=10005_1776417862577_r40kwzd3zt&refer_page_sn=10005&_x_sessn_id=ox547fwxta"
}

response = requests.post(
    url,
    headers=headers,
    cookies=cookies,
    json=json_data,
    timeout=30
)

print("status:", response.status_code)
print(response.text)