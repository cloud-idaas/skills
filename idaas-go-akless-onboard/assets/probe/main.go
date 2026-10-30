// Offline contract uses the real SDK signer and an in-memory transport.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/aliyun/alibaba-cloud-sdk-go/sdk"
	cred "github.com/aliyun/alibaba-cloud-sdk-go/sdk/auth/credentials"
	"github.com/aliyun/alibaba-cloud-sdk-go/sdk/requests"
	credentials "github.com/aliyun/credentials-go/credentials"
	"github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
	config "github.com/cloud-idaas/idaas-go-core-sdk/config"
	"github.com/cloud-idaas/idaas-go-core-sdk/factory"
)

type source interface {
	GetCredential() (*credentials.CredentialModel, error)
}
type bridge struct{ source source }

func (*bridge) GetProviderName() string { return "idaas_pam" }
func (b *bridge) GetCredentials() (*cred.Credentials, error) {
	m, e := b.source.GetCredential()
	if e != nil {
		return nil, e
	}
	if m == nil || m.AccessKeyId == nil || m.AccessKeySecret == nil || m.SecurityToken == nil {
		return nil, fmt.Errorf("incomplete credential")
	}
	return &cred.Credentials{AccessKeyId: *m.AccessKeyId, AccessKeySecret: *m.AccessKeySecret, SecurityToken: *m.SecurityToken, ProviderName: b.GetProviderName()}, nil
}

type fakeSource struct {
	generation int
	fail       bool
}

func (s *fakeSource) GetCredential() (*credentials.CredentialModel, error) {
	if s.fail {
		return nil, fmt.Errorf("offline failure")
	}
	id := fmt.Sprintf("fixture-id-%d", s.generation)
	key := "fixture-secret"
	token := fmt.Sprintf("fixture-token-%d", s.generation)
	return &credentials.CredentialModel{AccessKeyId: &id, AccessKeySecret: &key, SecurityToken: &token}, nil
}

type transport struct {
	generation *int
	calls      int
}

func (t *transport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.calls++
	r.ParseForm()
	if r.Form.Get("AccessKeyId") != fmt.Sprintf("fixture-id-%d", *t.generation) || r.Form.Get("SecurityToken") != fmt.Sprintf("fixture-token-%d", *t.generation) || r.Form.Get("Signature") == "" {
		return nil, fmt.Errorf("stale or unsigned credential")
	}
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"RequestId":"offline"}`)), Request: r}, nil
}
func request(client *sdk.Client, offline bool) error {
	r := requests.NewCommonRequest()
	r.Scheme = "https"
	r.Domain = "ecs.aliyuncs.com"
	r.Version = "2014-05-26"
	r.ApiName = "DescribeRegions"
	r.Method = "POST"
	_, e := client.ProcessCommonRequest(r)
	return e
}
func contract() bool {
	s := &fakeSource{}
	t := &transport{generation: &s.generation}
	cfg := sdk.NewConfig()
	cfg.Transport = t
	cfg.AutoRetry = false
	client, e := sdk.NewClientWithOptions("cn-hangzhou", cfg, &bridge{s})
	if e != nil {
		return false
	}
	if request(client, true) != nil {
		return false
	}
	s.generation++
	if request(client, true) != nil {
		return false
	}
	// A cached startup snapshot must fail after rotation (negative control).
	snapshot, _ := (&bridge{s}).GetCredentials()
	s.generation++
	stale, e := sdk.NewClientWithOptions("cn-hangzhou", cfg, cred.NewStsTokenCredential(snapshot.AccessKeyId, snapshot.AccessKeySecret, snapshot.SecurityToken))
	if e != nil {
		return false
	}
	if request(stale, true) == nil {
		return false
	}
	s.fail = true
	before := t.calls
	return request(client, true) != nil && t.calls == before
}
func main() {
	mode := "contract"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	result := map[string]interface{}{"mode": mode, "ok": false, "refresh_expiry_verified": false}
	if mode == "contract" {
		result["ok"] = contract()
		result["scope"] = "legacy_openapi_signer_rotation_and_failures"
	} else if mode == "smoke" {
		result["action"] = "ecs:DescribeRegions"
		stage := "configuration"
		run := func() error {
			c, e := config.NewConfigReader().LoadWithPriority(os.Getenv("CLOUD_IDAAS_CONFIG_PATH"))
			if e != nil {
				return e
			}
			stage = "core_init"
			if e = factory.GetInstance().Initialize(c); e != nil {
				return e
			}
			stage = "credential_acquisition"
			p, e := pam.GetAlibabaCloudCredentialsProvider(os.Getenv("ALIBABA_CLOUD_ROLE_ARN"))
			if e != nil {
				return e
			}
			if _, e = (&bridge{p}).GetCredentials(); e != nil {
				return e
			}
			result["credential_acquired"] = true
			stage = "read_only_call"
			client, e := sdk.NewClientWithOptions(os.Getenv("ALIBABA_CLOUD_REGION_ID"), sdk.NewConfig(), &bridge{p})
			if e != nil {
				return e
			}
			return request(client, false)
		}
		if run() == nil {
			result["ok"] = true
		} else {
			result["failed_stage"] = stage
		}
	}
	json.NewEncoder(os.Stdout).Encode(result)
	if result["ok"] != true {
		os.Exit(1)
	}
}
